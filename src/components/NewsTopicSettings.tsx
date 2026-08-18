import { useEffect, useState } from "react";
import {
  acceptTopicSuggestion,
  addNewsTopic,
  checkTopicSuggestions,
  dismissTopicSuggestion,
  fetchNewsTopics,
  removeNewsTopic,
  setNewsTopicDomains,
  type NewsTopic,
  type PendingTopicSuggestion,
} from "../integrations/newsFeed/api";

function parseDomainsInput(text: string): string[] {
  return text
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Topic management for the personalized news feed, plus its own
 * accept/dismiss surface for auto-suggested topics (kept self-contained in
 * Settings rather than adding another card to an already-busy Today). Each
 * topic can optionally be scoped to a set of trusted domains — when set,
 * that topic's web search only searches those sources instead of the open
 * web. */
export function NewsTopicSettings() {
  const [topics, setTopics] = useState<NewsTopic[]>();
  const [suggestions, setSuggestions] = useState<PendingTopicSuggestion[]>();
  const [newTopic, setNewTopic] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [expandedId, setExpandedId] = useState<string>();
  const [domainsDraft, setDomainsDraft] = useState<Record<string, string>>({});

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

  function toggleExpand(topic: NewsTopic) {
    if (expandedId === topic.id) {
      setExpandedId(undefined);
      return;
    }
    setExpandedId(topic.id);
    setDomainsDraft((prev) => ({ ...prev, [topic.id]: topic.preferredDomains.join(", ") }));
  }

  async function handleSaveDomains(topicId: string) {
    const domains = parseDomainsInput(domainsDraft[topicId] ?? "");
    setBusyId(topicId);
    try {
      const updated = await setNewsTopicDomains(topicId, domains);
      setTopics((prev) => prev?.map((t) => (t.id === topicId ? updated : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save those sources.");
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
        a day. Add or remove anytime — optionally scope a topic's web search to trusted sources instead of the open
        web.
      </p>

      <ul className="mb-3 space-y-1.5">
        {topics?.map((topic) => (
          <li key={topic.id} className="rounded-xl border border-line px-3 py-2 dark:border-line-dark">
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => toggleExpand(topic)}
                className="min-w-0 flex-1 text-left text-sm text-ink dark:text-ink-dark"
              >
                {topic.name}
                <span className="ml-2 text-xs text-ink-faint dark:text-ink-faint-dark">
                  {topic.preferredDomains.length > 0 ? `${topic.preferredDomains.length} trusted sources` : "open web"}
                </span>
              </button>
              <button
                onClick={() => handleRemove(topic.id)}
                disabled={busyId === topic.id}
                aria-label={`Remove ${topic.name}`}
                className="shrink-0 text-ink-faint hover:text-claude disabled:opacity-50 dark:text-ink-faint-dark"
              >
                ×
              </button>
            </div>
            {expandedId === topic.id && (
              <div className="mt-2">
                <textarea
                  value={domainsDraft[topic.id] ?? ""}
                  onChange={(e) => setDomainsDraft((prev) => ({ ...prev, [topic.id]: e.target.value }))}
                  onBlur={() => handleSaveDomains(topic.id)}
                  placeholder="e.g. bbc.co.uk, thesquareball.net — blank searches the open web"
                  rows={2}
                  className="w-full rounded-xl border border-line bg-paper-raised px-3 py-2 text-xs text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
                />
              </div>
            )}
          </li>
        ))}
        {topics && topics.length === 0 && (
          <p className="text-xs text-ink-faint dark:text-ink-faint-dark">No topics yet — add one below.</p>
        )}
      </ul>

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
