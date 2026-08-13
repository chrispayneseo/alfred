import { useState, type FormEvent } from "react";
import { ModelTag } from "../components/ModelTag";
import { makeId } from "../lib/id";
import { routeToModel } from "../lib/modelRouter";
import { nextMockReply } from "../mocks/chat";
import type { ChatMessage } from "../types";

const initialMessages: ChatMessage[] = [
  {
    id: "m0",
    role: "assistant",
    text: "Morning. Anything you want me to look into, or something on your mind?",
    model: "chatgpt",
    createdAt: new Date().toISOString(),
  },
];

export function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setIsThinking(true);

    const model = routeToModel(text);
    window.setTimeout(() => {
      const reply: ChatMessage = {
        id: makeId(),
        role: "assistant",
        text: nextMockReply(model === "claude"),
        model,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, reply]);
      setIsThinking(false);
    }, 500);
  }

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col px-5 pb-24 pt-[max(2rem,env(safe-area-inset-top))]">
      <h1 className="mb-4 text-xl font-medium tracking-tight text-ink dark:text-ink-dark">Chat</h1>

      <div className="flex-1 space-y-5 overflow-y-auto pb-4">
        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "text-right" : ""}>
            {message.role === "assistant" && message.model && (
              <div className="mb-1">
                <ModelTag model={message.model} />
              </div>
            )}
            <p
              className={`inline-block max-w-[85%] rounded-2xl px-4 py-2.5 text-left text-sm ${
                message.role === "user"
                  ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                  : "bg-paper-raised text-ink dark:bg-paper-raised-dark dark:text-ink-dark"
              }`}
            >
              {message.text}
            </p>
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
          disabled={!draft.trim()}
          className="rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
        >
          Send
        </button>
      </form>
    </div>
  );
}
