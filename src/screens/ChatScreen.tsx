import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ModelTag } from "../components/ModelTag";
import { createCalendarEvent } from "../integrations/google-calendar/api";
import { askLocalGateway, resolveToolApproval, sendChatMessage, sendLocalOnly, sendPlainCloudMessage, type ChatApiResult } from "../integrations/llm/api";
import { createLocationReminder } from "../integrations/notion/api";
import { createRecipe } from "../integrations/recipes/api";
import { useLiveLocation } from "../hooks/useLiveLocation";
import { makeId } from "../lib/id";
import { planGatewayDecision } from "../lib/gatewayDecision";
import { CONTENT_MAX_WIDTH, CONTENT_PADDING_X } from "../lib/layout";
import { useOnlineStatus } from "../lib/useOnlineStatus";
import type { ChatMessage, EventProposal, LocationReminderProposal, MealType, RecipeProposal } from "../types";

const MEAL_TYPES: MealType[] = ["Breakfast", "Lunch", "Dinner", "Snack", "Baking"];

function formatEventProposal(p: EventProposal): string {
  const d = new Date(`${p.date}T00:00:00`);
  const dateLabel = Number.isNaN(d.getTime())
    ? p.date
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (!p.startTime) return `${dateLabel} · All day`;
  return `${dateLabel} · ${p.startTime}${p.endTime ? `–${p.endTime}` : ""}`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Late one.";
  if (hour < 12) return "Morning.";
  if (hour < 18) return "Afternoon.";
  return "Evening.";
}

function buildInitialMessages(): ChatMessage[] {
  return [
    {
      id: "m0",
      role: "assistant",
      text: `${greeting()} Anything you want me to look into, or something on your mind?`,
      createdAt: new Date().toISOString(),
    },
  ];
}

const MODEL_LABEL = { local: "Alfred Local", claude: "Claude", chatgpt: "ChatGPT" } as const;

export function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>(buildInitialMessages);
  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [submittingEventId, setSubmittingEventId] = useState<string>();
  const [submittingLocationReminderId, setSubmittingLocationReminderId] = useState<string>();
  const [submittingRecipeId, setSubmittingRecipeId] = useState<string>();
  const online = useOnlineStatus();
  const { coords } = useLiveLocation();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isThinking) return;

    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");

    if (!online) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          text: "You're offline, so I can't reach the Dell right now — I'll be here once you're back online.",
          isError: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }

    setIsThinking(true);
    try {
      const gateway = await askLocalGateway(text);
      const plan = planGatewayDecision(gateway, text);
      if (plan.kind === "approval") {
        setMessages((prev) => [...prev, {
          id: makeId(), role: "assistant", text: plan.reason,
          cloudPrompt: plan.prompt, cloudScope: plan.scope, cloudStatus: "pending",
          cloudLocation: plan.scope === "connected" ? coords : undefined,
          createdAt: new Date().toISOString(),
        }]);
        return;
      }
      if (plan.kind === "tool_approval") {
        setMessages((prev) => [...prev, {
          id: makeId(), role: "assistant", text: plan.reason,
          toolApprovalId: plan.approvalId, toolApprovalAction: plan.action,
          toolApprovalIntegration: plan.integration, toolApprovalStatus: "pending",
          createdAt: new Date().toISOString(),
        }]);
        return;
      }
      setMessages((prev) => [...prev, {
        id: makeId(), role: "assistant", text: plan.reply, model: "local",
        sources: plan.sources,
        createdAt: new Date().toISOString(),
      }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          text: error instanceof Error ? error.message : "Something went wrong reaching Alfred.",
          isError: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  }

  function cloudMessage(result: ChatApiResult): ChatMessage {
    return {
      id: makeId(), role: "assistant", text: result.text, model: result.model,
      confidence: result.confidence,
      note: result.fellBack
        ? `${MODEL_LABEL[result.intendedModel]} unavailable — answered with ${MODEL_LABEL[result.model]}`
        : undefined,
      eventProposal: result.eventProposal,
      eventProposalStatus: result.eventProposal ? "pending" : undefined,
      locationReminderProposal: result.locationReminderProposal,
      locationReminderProposalStatus: result.locationReminderProposal ? "pending" : undefined,
      recipeProposal: result.recipeProposal,
      recipeProposalStatus: result.recipeProposal ? "pending" : undefined,
      recipeProposalMealType: result.recipeProposal?.mealType ?? "Dinner",
      createdAt: new Date().toISOString(),
    };
  }

  async function handleToolApproval(messageId: string, approvalId: string, approved: boolean) {
    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, toolApprovalStatus: "sending" } : m));
    try {
      const result = await resolveToolApproval(approvalId, approved);
      const completed = approved && result.state === "completed" && result.execution?.verification?.ok === true;
      setMessages((prev) => prev.map((m) => m.id === messageId ? {
        ...m,
        toolApprovalStatus: approved ? (completed ? "approved" : "error") : "rejected",
        note: approved && !completed ? "Alfred could not verify that the approved action completed." : m.note,
      } : m));
    } catch (error) {
      setMessages((prev) => prev.map((m) => m.id === messageId ? {
        ...m, toolApprovalStatus: "error",
        note: error instanceof Error ? error.message : "Action approval failed",
      } : m));
    }
  }

  async function handleApproveCloud(messageId: string, prompt: string, scope: "prompt_only" | "connected", location?: { lat: number; lon: number }) {
    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, cloudStatus: "sending" } : m));
    try {
      const result = scope === "connected"
        ? await sendChatMessage([{ role: "user", content: prompt }], location)
        : await sendPlainCloudMessage(prompt);
      setMessages((prev) => [
        ...prev.map((m) => m.id === messageId ? { ...m, cloudStatus: "sent" as const } : m),
        cloudMessage(result),
      ]);
    } catch (error) {
      setMessages((prev) => prev.map((m) => m.id === messageId
        ? { ...m, cloudStatus: "error", note: error instanceof Error ? error.message : "Cloud request failed" }
        : m));
    }
  }

  async function handleKeepLocal(messageId: string, prompt: string) {
    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, cloudStatus: "sending" } : m));
    try {
      const reply = await sendLocalOnly(prompt);
      setMessages((prev) => [
        ...prev.map((m) => m.id === messageId ? { ...m, cloudStatus: "cancelled" as const } : m),
        { id: makeId(), role: "assistant", text: reply, model: "local", createdAt: new Date().toISOString() },
      ]);
    } catch (error) {
      setMessages((prev) => prev.map((m) => m.id === messageId
        ? { ...m, cloudStatus: "error", note: error instanceof Error ? error.message : "Local request failed" }
        : m));
    }
  }

  async function handleConfirmEvent(messageId: string, proposal: EventProposal) {
    setSubmittingEventId(messageId);
    try {
      await createCalendarEvent(proposal);
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, eventProposalStatus: "created" } : m)));
    } catch (error) {
      const needsReconnect = error instanceof Error && (error.message === "reconnect_required" || error.message === "not_connected");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                eventProposalStatus: "error",
                eventProposalError: needsReconnect
                  ? `${proposal.account} needs reconnecting in Settings before Alfred can add events.`
                  : error instanceof Error
                    ? error.message
                    : "Couldn't add that to your calendar.",
              }
            : m
        )
      );
    } finally {
      setSubmittingEventId(undefined);
    }
  }

  function handleCancelEvent(messageId: string) {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, eventProposalStatus: "cancelled" } : m)));
  }

  async function handleConfirmLocationReminder(messageId: string, proposal: LocationReminderProposal) {
    setSubmittingLocationReminderId(messageId);
    try {
      await createLocationReminder(proposal.text, proposal.locationTrigger, proposal.project);
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, locationReminderProposalStatus: "created" } : m)));
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                locationReminderProposalStatus: "error",
                locationReminderProposalError: error instanceof Error ? error.message : "Couldn't save that reminder.",
              }
            : m
        )
      );
    } finally {
      setSubmittingLocationReminderId(undefined);
    }
  }

  function handleCancelLocationReminder(messageId: string) {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, locationReminderProposalStatus: "cancelled" } : m)));
  }

  function handleRecipeMealTypeChange(messageId: string, mealType: MealType) {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, recipeProposalMealType: mealType } : m)));
  }

  async function handleConfirmRecipe(messageId: string, proposal: RecipeProposal, mealType: MealType) {
    setSubmittingRecipeId(messageId);
    try {
      await createRecipe(proposal.title, mealType, {
        cuisineType: proposal.cuisineType,
        prepTime: proposal.prepTime,
        cookTime: proposal.cookTime,
        sourceUrl: proposal.sourceUrl,
        ingredients: proposal.ingredients,
        method: proposal.method,
        tags: proposal.tags,
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, recipeProposalStatus: "created" } : m)));
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, recipeProposalStatus: "error", recipeProposalError: error instanceof Error ? error.message : "Couldn't save that recipe." }
            : m
        )
      );
    } finally {
      setSubmittingRecipeId(undefined);
    }
  }

  function handleCancelRecipe(messageId: string) {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, recipeProposalStatus: "cancelled" } : m)));
  }

  return (
    <div className={`mx-auto flex h-dvh ${CONTENT_MAX_WIDTH} flex-col ${CONTENT_PADDING_X} pb-24 pt-[max(2rem,env(safe-area-inset-top))]`}>
      <h1 className="mb-4 text-xl font-medium tracking-tight text-ink dark:text-ink-dark">Chat</h1>

      <div className="flex-1 space-y-5 overflow-y-auto pb-4">
        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "text-right" : ""}>
            {message.role === "assistant" && message.model && (
              <div className="mb-1 flex items-center gap-2">
                <ModelTag model={message.model} />
                {message.confidence === "inferred" && (
                  <span className="text-[11px] text-ink-faint dark:text-ink-faint-dark">
                    · Best guess based on past pattern
                  </span>
                )}
              </div>
            )}
            <p
              className={`inline-block max-w-[85%] lg:max-w-xl rounded-2xl px-4 py-2.5 text-left text-sm ${
                message.role === "user"
                  ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                  : message.isError
                    ? "bg-paper-raised text-ink-soft dark:bg-paper-raised-dark dark:text-ink-soft-dark"
                    : "bg-paper-raised text-ink dark:bg-paper-raised-dark dark:text-ink-dark"
              }`}
            >
              {message.text}
            </p>
            {message.note && (
              <p className="mt-1 text-[11px] text-ink-faint dark:text-ink-faint-dark">{message.note}</p>
            )}
            {message.sources && message.sources.length > 0 && (
              <div className="mt-2 max-w-xl space-y-1 text-left">
                <p className="text-xs text-ink-faint dark:text-ink-faint-dark">Saved on your Dell · sources</p>
                {message.sources.map((source) => {
                  const safeUrl = /^\/settings\?memory=\d+$/.test(source.url) || /^\/today\?localItem=[a-zA-Z0-9_%.-]+$/.test(source.url);
                  return safeUrl && <Link key={source.id} to={source.url} className="block rounded-xl border border-line px-3 py-2 text-xs text-ink underline dark:border-line-dark dark:text-ink-dark">
                    {source.kind === "memory" ? "Note" : source.kind === "task" ? "Task" : "Reminder"}: {source.title}{source.due ? ` · ${source.due}` : ""}
                  </Link>;
                })}
              </div>
            )}
            {message.toolApprovalId && (
              <div className="mt-2 max-w-xl rounded-2xl border border-line p-3 text-left dark:border-line-dark">
                <p className="text-xs text-ink-soft dark:text-ink-soft-dark">
                  This action will be performed by Alfred Core. No cloud model is involved.
                </p>
                <p className="mt-2 text-sm text-ink dark:text-ink-dark">{message.text}</p>
                {message.toolApprovalStatus === "pending" || message.toolApprovalStatus === "error" ? (
                  <div className="mt-3 flex gap-3">
                    <button onClick={() => handleToolApproval(message.id, message.toolApprovalId!, true)}
                      className="rounded-full bg-ink px-3 py-1.5 text-xs text-paper dark:bg-ink-dark dark:text-paper-dark">Approve</button>
                    <button onClick={() => handleToolApproval(message.id, message.toolApprovalId!, false)}
                      className="text-xs text-ink-soft dark:text-ink-soft-dark">Cancel</button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-ink-soft dark:text-ink-soft-dark">
                    {message.toolApprovalStatus === "sending" ? "Working…" : message.toolApprovalStatus === "approved" ? "Completed and verified." : "Cancelled."}
                  </p>
                )}
              </div>
            )}
            {message.cloudPrompt && (
              <div className="mt-2 max-w-xl rounded-2xl border border-line p-3 text-left dark:border-line-dark">
                <p className="text-xs text-ink-soft dark:text-ink-soft-dark">
                  {message.cloudScope === "connected"
                    ? `If you approve, Alfred may send relevant connected account data${message.cloudLocation ? " and your opted-in current location" : ""} with this request to Claude or ChatGPT. Dell memory stays private.`
                    : "Only this text will be sent to a cloud model. Alfred's saved memory and connected accounts are excluded:"}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-ink dark:text-ink-dark">{message.cloudPrompt}</p>
                {message.cloudStatus === "pending" || message.cloudStatus === "error" ? (
                  <div className="mt-3 flex gap-3">
                    <button onClick={() => handleApproveCloud(message.id, message.cloudPrompt!, message.cloudScope ?? "prompt_only", message.cloudLocation)}
                      className="rounded-full bg-ink px-3 py-1.5 text-xs text-paper dark:bg-ink-dark dark:text-paper-dark">{message.cloudScope === "connected" ? "Use connected account" : "Send to cloud"}</button>
                    <button onClick={() => handleKeepLocal(message.id, message.cloudPrompt!)}
                      className="text-xs text-ink-soft dark:text-ink-soft-dark">{message.cloudScope === "connected" ? "Answer without account" : "Answer locally"}</button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-ink-soft dark:text-ink-soft-dark">{message.cloudStatus === "sending" ? "Working…" : message.cloudStatus === "sent" ? "Sent with your approval." : "Answered locally."}</p>
                )}
              </div>
            )}
            {message.eventProposal && (
              <div className="mt-2 inline-block w-full max-w-[85%] lg:max-w-xl rounded-2xl border border-line px-4 py-3 text-left dark:border-line-dark">
                <p className="text-sm text-ink dark:text-ink-dark">{message.eventProposal.title}</p>
                <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">
                  {formatEventProposal(message.eventProposal)} · {message.eventProposal.account}
                </p>

                {message.eventProposalStatus === "created" && (
                  <p className="mt-2 text-xs text-ink-soft dark:text-ink-soft-dark">Added to calendar.</p>
                )}
                {message.eventProposalStatus === "cancelled" && (
                  <p className="mt-2 text-xs text-ink-faint dark:text-ink-faint-dark">Not added.</p>
                )}
                {message.eventProposalStatus === "error" && (
                  <>
                    <p className="mt-2 text-xs text-claude">{message.eventProposalError}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        onClick={() => handleConfirmEvent(message.id, message.eventProposal!)}
                        disabled={submittingEventId === message.id}
                        className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                      >
                        Try again
                      </button>
                    </div>
                  </>
                )}
                {message.eventProposalStatus === "pending" && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() => handleConfirmEvent(message.id, message.eventProposal!)}
                      disabled={submittingEventId === message.id}
                      className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                    >
                      {submittingEventId === message.id ? "Adding…" : "Add to calendar"}
                    </button>
                    <button
                      onClick={() => handleCancelEvent(message.id)}
                      disabled={submittingEventId === message.id}
                      className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            {message.locationReminderProposal && (
              <div className="mt-2 inline-block w-full max-w-[85%] lg:max-w-xl rounded-2xl border border-line px-4 py-3 text-left dark:border-line-dark">
                <p className="text-sm text-ink dark:text-ink-dark">{message.locationReminderProposal.text}</p>
                <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">
                  When: {message.locationReminderProposal.locationTrigger}
                </p>

                {message.locationReminderProposalStatus === "created" && (
                  <p className="mt-2 text-xs text-ink-soft dark:text-ink-soft-dark">Reminder saved.</p>
                )}
                {message.locationReminderProposalStatus === "cancelled" && (
                  <p className="mt-2 text-xs text-ink-faint dark:text-ink-faint-dark">Not added.</p>
                )}
                {message.locationReminderProposalStatus === "error" && (
                  <>
                    <p className="mt-2 text-xs text-claude">{message.locationReminderProposalError}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        onClick={() => handleConfirmLocationReminder(message.id, message.locationReminderProposal!)}
                        disabled={submittingLocationReminderId === message.id}
                        className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                      >
                        Try again
                      </button>
                    </div>
                  </>
                )}
                {message.locationReminderProposalStatus === "pending" && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() => handleConfirmLocationReminder(message.id, message.locationReminderProposal!)}
                      disabled={submittingLocationReminderId === message.id}
                      className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                    >
                      {submittingLocationReminderId === message.id ? "Saving…" : "Add reminder"}
                    </button>
                    <button
                      onClick={() => handleCancelLocationReminder(message.id)}
                      disabled={submittingLocationReminderId === message.id}
                      className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            {message.recipeProposal && (
              <div className="mt-2 inline-block w-full max-w-[85%] lg:max-w-xl rounded-2xl border border-line px-4 py-3 text-left dark:border-line-dark">
                <p className="text-sm text-ink dark:text-ink-dark">{message.recipeProposal.title}</p>

                {(message.recipeProposalStatus === "pending" || message.recipeProposalStatus === "error") && (
                  <div className="mt-2 flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
                    {MEAL_TYPES.map((mt) => (
                      <button
                        key={mt}
                        onClick={() => handleRecipeMealTypeChange(message.id, mt)}
                        className={`flex-1 rounded-full py-1 text-[11px] font-medium transition-colors ${
                          (message.recipeProposalMealType ?? "Dinner") === mt
                            ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                            : "text-ink-soft dark:text-ink-soft-dark"
                        }`}
                      >
                        {mt}
                      </button>
                    ))}
                  </div>
                )}

                {message.recipeProposalStatus === "created" && (
                  <p className="mt-2 text-xs text-ink-soft dark:text-ink-soft-dark">Added to your Recipe Bank.</p>
                )}
                {message.recipeProposalStatus === "cancelled" && (
                  <p className="mt-2 text-xs text-ink-faint dark:text-ink-faint-dark">Not added.</p>
                )}
                {message.recipeProposalStatus === "error" && (
                  <>
                    <p className="mt-2 text-xs text-claude">{message.recipeProposalError}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        onClick={() => handleConfirmRecipe(message.id, message.recipeProposal!, message.recipeProposalMealType ?? "Dinner")}
                        disabled={submittingRecipeId === message.id}
                        className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                      >
                        Try again
                      </button>
                    </div>
                  </>
                )}
                {message.recipeProposalStatus === "pending" && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() => handleConfirmRecipe(message.id, message.recipeProposal!, message.recipeProposalMealType ?? "Dinner")}
                      disabled={submittingRecipeId === message.id}
                      className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                    >
                      {submittingRecipeId === message.id ? "Adding…" : "Add to Recipe Bank"}
                    </button>
                    <button
                      onClick={() => handleCancelRecipe(message.id)}
                      disabled={submittingRecipeId === message.id}
                      className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {isThinking && (
          <p className="text-xs text-ink-faint dark:text-ink-faint-dark">thinking…</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-line pt-3 dark:border-line-dark">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask Alfred anything…"
          className="flex-1 rounded-full border border-line bg-paper-raised px-4 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark dark:placeholder:text-ink-faint-dark"
        />
        <button
          type="submit"
          disabled={!draft.trim() || isThinking}
          className="rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
        >
          Send
        </button>
      </form>
    </div>
  );
}
