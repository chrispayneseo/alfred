import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchNewsFeed, type NewsFeedResult } from "../integrations/newsFeed/api";

/** Silent while loading or empty — same philosophy as WeeklyDigestTeaser.
 * This doubles as the check-on-open trigger for the day's feed generation
 * (the GET request is what actually runs checkNewsFeed server-side). */
export function NewsFeedTeaser() {
  const [feed, setFeed] = useState<NewsFeedResult>();

  useEffect(() => {
    fetchNewsFeed()
      .then(setFeed)
      .catch(() => undefined);
  }, []);

  if (!feed || feed.items.length === 0) return null;

  const count = feed.items.length;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Your feed</h2>
      <Link to="/feed" className="block rounded-2xl border border-line px-4 py-3.5 dark:border-line-dark">
        <p className="text-sm text-ink dark:text-ink-dark">
          {count} new {count === 1 ? "story" : "stories"} in your feed
        </p>
        <p className="mt-1.5 text-xs text-ink-faint dark:text-ink-faint-dark">Open Feed →</p>
      </Link>
    </section>
  );
}
