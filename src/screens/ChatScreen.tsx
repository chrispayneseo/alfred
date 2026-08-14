import { useState, type FormEvent } from "react";
import { ModelTag } from "../components/ModelTag";
import { createCalendarEvent } from "../integrations/google-calendar/api";
import { sendChatMessage, type ChatApiTurn } from "../integrations/llm/api";
import { makeId } from "../lib/id";
import { useOnlineStatus } from "../lib/useOnlineStatus";
import type { ChatMessage, EventProposal } from "../types";

function formatEventProposal(p: EventProposal): string {
  const d = new Date(`${p.date}T00:00:00`);
  const dateLabel = Number.isNaN(d.getTime())
    ? p.date
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (!p.startTime) return `${dateLabel} · All day`;
  return `${dateLabel} · ${p.startTime}${p.endTime ? `–${p.endTime}` : ""}`;
}

const initialMessages: ChatMessage[] = [
  {
    id: "m0",
    role: "assistant",
    text: "Morning. Anything you want me to look into, or something on your mind?",
    createdAt: new Date().toISOString(),
  },
];

const MODEL_LABEL = { claude: "Claude", chatgpt: "ChatGPT" } as const;

export function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [submittingEventId, setSubmittingEventId] = useState<string>();
  const online = useOnlineStatus();

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
    const history: ChatApiTurn[] = [...messages, userMessage].map((m) => ({
      role: m.role,
      content: m.text,
    }));

    setMessages((prev) => [...prev, userMessage]);
    setDraft("");

    if (!online) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          text: "You're offline, so I can't reach Claude or ChatGPT right now — I'll be here once you're back online.",
          isError: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }

    setIsThinking(true);
    try {
      const result = await sendChatMessage(history);
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          text: result.text,
          model: result.model,
          confidence: result.confidence,
          note: result.fellBack
            ? `${MODEL_LABEL[result.intendedModel]} unavailable — answered with ${MODEL_LABEL[result.model]}`
            : undefined,
          eventProposal: result.eventProposal,
          eventProposalStatus: result.eventProposal ? "pending" : undefined,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (error) {
      const bothDown = error instanceof Error && error.message === "both_unavailable";
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          text: bothDown
            ? "Claude and ChatGPT are both unavailable right now. Try again in a moment."
            : "Something went wrong reaching the assistant. Try again in a moment.",
          isError: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsThinking(false);
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

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col px-5 pb-24 pt-[max(2rem,env(safe-area-inset-top))]">
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
              className={`inline-block max-w-[85%] rounded-2xl px-4 py-2.5 text-left text-sm ${
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
            {message.eventProposal && (
              <div className="mt-2 inline-block w-full max-w-[85%] rounded-2xl border border-line px-4 py-3 text-left dark:border-line-dark">
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
