import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Screen } from "../components/Screen";
import {
  fetchWeeklyDigest,
  generateWeeklyDigestNow,
  isDigestReady,
  type WeeklyDigest,
} from "../integrations/digest/api";

const TRIGGER_LABEL = { sunday: "Sunday evening", monday: "Monday morning" } as const;

function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

export function DigestScreen() {
  const [digest, setDigest] = useState<WeeklyDigest>();
  const [error, setError] = useState<string>();
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    fetchWeeklyDigest()
      .then(setDigest)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the digest."));
  }, []);

  async function handleGenerateNow() {
    setGenerating(true);
    setError(undefined);
    try {
      setDigest(await generateWeeklyDigestNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't generate the digest.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Screen
      title="Weekly digest"
      subtitle="The week ahead, across everything"
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

      {!error && !digest && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}

      {digest && isDigestReady(digest) && (
        <>
          <p className="mb-4 text-xs text-ink-faint dark:text-ink-faint-dark">
            Generated {formatGeneratedAt(digest.generatedAt)}
          </p>
          <div className="space-y-3 text-sm leading-relaxed text-ink dark:text-ink-dark">
            {digest.summary.split("\n\n").map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </>
      )}

      {digest && !isDigestReady(digest) && (
        <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
          Your next digest arrives {TRIGGER_LABEL[digest.triggerDay]}. You can preview it early below.
        </p>
      )}

      {digest && (
        <button
          onClick={handleGenerateNow}
          disabled={generating}
          className="mt-8 rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-ink-faint disabled:opacity-50 dark:border-line-dark dark:text-ink-soft-dark dark:hover:border-ink-faint-dark"
        >
          {generating ? "Generating…" : isDigestReady(digest) ? "Regenerate now" : "Preview now"}
        </button>
      )}
    </Screen>
  );
}
