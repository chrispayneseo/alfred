import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Screen } from "../components/Screen";
import {
  acceptMealPlanDay,
  fetchCurrentMealPlan,
  rejectMealPlanDay,
  sendMealPlan,
  skipMealPlanDay,
  startMealPlan,
  type MealPlanState,
} from "../integrations/recipes/api";

function formatDayDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function MealPlanScreen() {
  const [plan, setPlan] = useState<MealPlanState | null>();
  const [busy, setBusy] = useState(false);
  const [fading, setFading] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<{ sentTo: string; mealCount: number }>();

  useEffect(() => {
    fetchCurrentMealPlan()
      .then(setPlan)
      .catch(() => setPlan(null));
  }, []);

  async function handleStart() {
    setBusy(true);
    setError(undefined);
    try {
      setPlan(await startMealPlan());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the meal plan.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAccept() {
    if (!plan) return;
    setBusy(true);
    try {
      setPlan(await acceptMealPlanDay(plan.sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't lock that meal in.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!plan) return;
    setBusy(true);
    setFading(true);
    try {
      const next = await rejectMealPlanDay(plan.sessionId);
      // Brief fade before swapping the card content, per the design spec.
      setTimeout(() => {
        setPlan(next);
        setFading(false);
      }, 150);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get a new suggestion.");
      setFading(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (!plan) return;
    setBusy(true);
    try {
      setPlan(await skipMealPlanDay(plan.sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't skip that day.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await sendMealPlan(plan.sessionId);
      setSent(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the meal plan.");
    } finally {
      setBusy(false);
    }
  }

  const currentDay = plan?.days.find((d) => d.status === "pending");
  const resolvedDays = plan?.days.filter((d) => d.status !== "pending") ?? [];

  return (
    <Screen
      title="Meal Plan"
      subtitle="One suggestion at a time, for the week ahead"
      headerAction={
        <Link
          to="/browse"
          className="mt-1 rounded-full p-1.5 text-ink-faint hover:text-ink dark:text-ink-faint-dark dark:hover:text-ink-dark"
          aria-label="Back to Browse"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      }
    >
      {error && <p className="mb-4 text-sm text-claude">{error}</p>}

      {plan === undefined && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}

      {plan === null && !sent && (
        <div>
          <p className="mb-4 text-sm text-ink-soft dark:text-ink-soft-dark">
            Build a dinner plan for the week ahead, one suggestion at a time — accept, reject, or skip each day, then
            send yourself the final list.
          </p>
          <button
            onClick={handleStart}
            disabled={busy}
            className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
          >
            {busy ? "Starting…" : "Plan this week's meals"}
          </button>
        </div>
      )}

      {sent && (
        <div className="rounded-2xl border border-line px-4 py-3.5 dark:border-line-dark">
          <p className="text-sm text-ink dark:text-ink-dark">
            Sent to {sent.sentTo} — {sent.mealCount} meal{sent.mealCount === 1 ? "" : "s"} planned.
          </p>
          <Link
            to="/browse"
            className="mt-2 inline-block text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
          >
            Back to Recipe Bank
          </Link>
        </div>
      )}

      {plan && plan.status === "active" && !sent && (
        <div>
          {resolvedDays.length > 0 && (
            <ul className="mb-6 space-y-1.5">
              {resolvedDays.map((d) => (
                <li key={d.dayIndex} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-ink-faint dark:text-ink-faint-dark">
                    {d.dayLabel} · {formatDayDate(d.date)}
                  </span>
                  <span className={d.status === "skipped" ? "text-ink-faint dark:text-ink-faint-dark" : "text-ink-soft dark:text-ink-soft-dark"}>
                    {d.status === "skipped" ? "Skipped" : d.recipeTitle}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {currentDay && (
            <div className={`transition-opacity duration-150 ${fading ? "opacity-0" : "opacity-100"}`}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                {currentDay.dayLabel} · {formatDayDate(currentDay.date)}
              </p>

              {currentDay.candidate ? (
                <div className="rounded-2xl border border-line px-4 py-4 dark:border-line-dark">
                  <p className="text-base font-medium text-ink dark:text-ink-dark">{currentDay.candidate.title}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-faint dark:text-ink-faint-dark">
                    {currentDay.candidate.category && <span>{currentDay.candidate.category}</span>}
                    {currentDay.candidate.cuisineType && <span>{currentDay.candidate.cuisineType}</span>}
                    {currentDay.candidate.prepTime && <span>Prep {currentDay.candidate.prepTime}</span>}
                    {currentDay.candidate.cookTime && <span>Cook {currentDay.candidate.cookTime}</span>}
                  </div>
                  <a
                    href={currentDay.candidate.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                  >
                    View full recipe →
                  </a>

                  <div className="mt-4 flex items-center gap-3">
                    <button
                      onClick={handleAccept}
                      disabled={busy}
                      aria-label="Accept"
                      className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                    <button
                      onClick={handleReject}
                      disabled={busy}
                      aria-label="Reject — show another suggestion"
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-line text-ink-soft disabled:opacity-50 dark:border-line-dark dark:text-ink-soft-dark"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                    <button
                      onClick={handleSkip}
                      disabled={busy}
                      className="ml-auto text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                    >
                      Skip this day
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-line px-4 py-4 dark:border-line-dark">
                  <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
                    No more suggestions left for this day that fit the rules — try skipping it.
                  </p>
                  <button
                    onClick={handleSkip}
                    disabled={busy}
                    className="mt-3 rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink-soft disabled:opacity-50 dark:border-line-dark dark:text-ink-soft-dark"
                  >
                    Skip this day
                  </button>
                </div>
              )}
            </div>
          )}

          {plan.allResolved && (
            <div className="mt-6">
              <button
                onClick={handleSend}
                disabled={busy}
                className="w-full rounded-full bg-ink py-2.5 text-sm font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
              >
                {busy ? "Sending…" : "Generate email"}
              </button>
            </div>
          )}
        </div>
      )}
    </Screen>
  );
}
