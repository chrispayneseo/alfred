import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Screen } from "../components/Screen";
import { fetchNewsFeed, type NewsFeedItem, type NewsFeedResult } from "../integrations/newsFeed/api";

function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

function groupByTopic(items: NewsFeedItem[]): { topic: string; items: NewsFeedItem[] }[] {
  const groups: { topic: string; items: NewsFeedItem[] }[] = [];
  for (const item of items) {
    const existing = groups.find((g) => g.topic === item.topicName);
    if (existing) existing.items.push(item);
    else groups.push({ topic: item.topicName, items: [item] });
  }
  return groups;
}

export function FeedScreen() {
  const [feed, setFeed] = useState<NewsFeedResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchNewsFeed()
      .then(setFeed)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load your feed."));
  }, []);

  const groups = useMemo(() => (feed ? groupByTopic(feed.items) : []), [feed]);

  return (
    <Screen
      title="Feed"
      subtitle="Your topics, once a day"
      headerAction={
        <Link
          to="/today"
          className="mt-1 rounded-full p-1.5 text-ink-faint hover:text-ink dark:text-ink-faint-dark dark:hover:text-ink-dark"
          aria-label="Back to Today"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      }
    >
      {error && <p className="mb-4 text-sm text-claude">{error}</p>}

      {!error && !feed && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}

      {feed && feed.items.length === 0 && (
        <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
          Nothing genuinely new across your topics today — check back tomorrow, or{" "}
          <Link to="/settings#automations" className="underline decoration-ink-faint/40 underline-offset-2">
            add more topics
          </Link>{" "}
          in Settings.
        </p>
      )}

      {feed && feed.items.length > 0 && (
        <>
          <p className="mb-6 text-xs text-ink-faint dark:text-ink-faint-dark">Generated {formatGeneratedAt(feed.generatedAt)}</p>
          <div className="space-y-8">
            {groups.map((group) => (
              <section key={group.topic}>
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                  {group.topic}
                </h2>
                <ul className="space-y-3">
                  {group.items.map((item) => (
                    <li key={item.id} className="rounded-2xl border border-line px-4 py-3.5 dark:border-line-dark">
                      <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="block">
                        <p className="text-sm font-medium text-ink dark:text-ink-dark">{item.headline}</p>
                        <p className="mt-1 text-sm leading-relaxed text-ink-soft dark:text-ink-soft-dark">{item.summary}</p>
                        <p className="mt-1.5 text-xs text-ink-faint dark:text-ink-faint-dark">{item.sourceLabel}</p>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}
