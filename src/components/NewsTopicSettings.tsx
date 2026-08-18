import { useEffect, useState } from "react";
import {
  acceptTopicSuggestion,
  addNewsTopic,
  checkTopicSuggestions,
  dismissTopicSuggestion,
  fetchNewsTopics,
  removeNewsTopic,
  type NewsTopic,
  type PendingTopicSuggestion,
} from "../integrations/newsFeed/api";

/** Topic management for the personalized news feed, plus its own
 * accept/dismiss surface for auto-suggested topics (kept self-contained in
 * Settings rather than adding another card to an already-busy Today). */
export function NewsTopicSettings() {
  const [topics, setTopics] = useState<NewsTopic[]>();
  const [suggestions, setSuggestions] = useState<PendingTopicSuggestion[]>();
  const [newTopic, setNewTopic] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchNewsTopics()
      .then(setTopics)
      .catch(() => setTopics([]));
    checkTopicSuggestions()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, []);

  async function handleAdd() {
    const name = newTopic.trim();
    if (!name) return;
    setAdding(true);
    setError(undefined);
    try {
      const created = await addNewsTopic(name);
      setTopics((prev) => (prev?.some((t) => t.id === created.id) ? prev : [...(prev ?? []), created]));
      setNewTopic("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that topic.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    setBusyId(id);
    try {
      await removeNewsTopic(id);
      setTopics((prev) => prev?.filter((t) => t.id !== id));
    } finally {
      setBusyId(undefined);
    }
  }

  async function handleAcceptSuggestion(id: string) {
    setBusyId(id);
    try {
      await acceptTopicSuggestion(id);
      setSuggestions((prev) => prev?.filter((s) => s.id !== id));
      fetchNewsTopics()
        .then(setTopics)
        .catch(() => undefined);
    } finally {
      setBusyId(undefined);
    }
  }

  async function handleDismissSuggestion(id: string) {
    setBusyId(id);
    try {
      await dismissTopicSuggestion(id);
      setSuggestions((prev) => prev?.filter((s) => s.id !== id));
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-ink-soft dark:text-ink-soft-dark">
        Alfred builds your daily Feed around these topics, searching for genuine news and matching newsletters once
        a day. Add or remove anytime.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        {topics?.map((topic) => (
          <span
            key={topic.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
          >
            {topic.name}
            <button
              onClick={() => handleRemove(topic.id)}
              disabled={busyId === topic.id}
              aria-label={`Remove ${topic.name}`}
              className="text-ink-faint hover:text-claude disabled:opacity-50 dark:text-ink-faint-dark"
            >
              ×
            </button>
          </span>
        ))}
        {topics && topics.length === 0 && (
          <p className="text-xs text-ink-faint dark:text-ink-faint-dark">No topics yet — add one below.</p>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={newTopic}
          onChange={(e) => setNewTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add a topic"
          className="min-w-0 flex-1 rounded-xl border border-line bg-paper-raised px-3 py-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newTopic.trim()}
          className="shrink-0 rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-claude">{error}</p>}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
            Suggested topics
          </p>
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.id} className="rounded-xl border border-line px-3 py-2.5 dark:border-line-dark">
                <p className="text-sm text-ink dark:text-ink-dark">{s.suggestedName}</p>
                <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">{s.reason}</p>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    onClick={() => handleAcceptSuggestion(s.id)}
                    disabled={busyId === s.id}
                    className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                  >
                    Add topic
                  </button>
                  <button
                    onClick={() => handleDismissSuggestion(s.id)}
                    disabled={busyId === s.id}
                    className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
