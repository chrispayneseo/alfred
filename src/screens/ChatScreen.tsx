import { useState, type FormEvent } from "react";
import { ModelTag } from "../components/ModelTag";
import { sendChatMessage, type ChatApiTurn } from "../integrations/llm/api";
import { makeId } from "../lib/id";
import { useOnlineStatus } from "../lib/useOnlineStatus";
import type { ChatMessage } from "../types";

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
