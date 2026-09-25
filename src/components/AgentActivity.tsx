import { useCallback, useEffect, useState } from "react";
import {
  fetchAgentActivity,
  type AgentActivityGoal,
  type AgentActivityToday,
} from "../integrations/local/agentActivity";

function stateLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function GoalRow({ goal }: { goal: AgentActivityGoal }) {
  const step = goal.current_step;
  return (
    <li className="rounded-xl border border-line px-3 py-2.5 dark:border-line-dark">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink dark:text-ink-dark">
            {goal.recipe?.title ?? "Durable goal"}
          </p>
          <p className="mt-0.5 text-xs capitalize text-ink-faint dark:text-ink-faint-dark">
            {stateLabel(goal.state)}
          </p>
        </div>
        {step && (
          <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-soft dark:border-line-dark dark:text-ink-soft-dark">
            {step.action}
          </span>
        )}
      </div>
      {step && (
        <div className="mt-2">
          <p className="text-xs text-ink-soft dark:text-ink-soft-dark">{step.why}</p>
          <p className="mt-1 text-[11px] text-ink-faint dark:text-ink-faint-dark">
            Step {step.position + 1} · {stateLabel(step.state)} · {stateLabel(step.risk_level)}
            {step.integration ? ` · ${step.integration}` : ""}
          </p>
        </div>
      )}
    </li>
  );
}

export function AgentActivity() {
  const [activity, setActivity] = useState<AgentActivityToday>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setActivity(await fetchAgentActivity());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Agent Activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <section className="mb-8 rounded-2xl border border-line p-4 dark:border-line-dark">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
            Agent activity
          </h2>
          <p className="mt-1 text-xs text-ink-faint dark:text-ink-faint-dark">
            Read-only metadata from Alfred Core · no connected content shown
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-xs underline text-ink-soft dark:text-ink-soft-dark"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading agent state…</p>}
      {error && <p role="alert" className="mb-3 text-xs text-claude">{error}</p>}

      {activity && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ["Active", activity.counts.active_goals],
              ["Approvals", activity.counts.waiting_approvals],
              ["Done today", activity.counts.completed_work_today],
              ["Attention", activity.counts.attention_items_today],
              ["Recipes", activity.counts.recipe_runs_today],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-black/[0.025] px-3 py-2 dark:bg-white/[0.04]">
                <p className="text-lg font-medium tabular-nums text-ink dark:text-ink-dark">{value}</p>
                <p className="text-[10px] uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">{label}</p>
              </div>
            ))}
          </div>

          {activity.waiting_approvals.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                Waiting for you
              </h3>
              <ul className="space-y-2">
                {activity.waiting_approvals.map((approval) => (
                  <li key={approval.approval_id} className="rounded-xl border border-line px-3 py-2 dark:border-line-dark">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-ink dark:text-ink-dark">
                        {approval.recipe?.title ?? approval.action}
                      </p>
                      <span className="text-[10px] uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                        {stateLabel(approval.risk_level)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-soft dark:text-ink-soft-dark">{approval.why}</p>
                    <p className="mt-1 text-[11px] text-ink-faint dark:text-ink-faint-dark">
                      {approval.action} · {stateLabel(approval.effect)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activity.attention_items.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                Needs attention
              </h3>
              <ul className="space-y-2">
                {activity.attention_items.slice(0, 5).map((item, index) => (
                  <li key={`${item.execution_id ?? "operation"}-${item.action}-${index}`} className="rounded-xl border border-line px-3 py-2 dark:border-line-dark">
                    <p className="text-sm text-ink dark:text-ink-dark">{item.action}</p>
                    <p className="mt-1 text-xs text-ink-soft dark:text-ink-soft-dark">
                      {item.why ?? stateLabel(item.state ?? "attention required")}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4">
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
              Active goals
            </h3>
            {activity.active_goals.length === 0 ? (
              <p className="text-sm text-ink-faint dark:text-ink-faint-dark">No active goals.</p>
            ) : (
              <ul className="space-y-2">
                {activity.active_goals.map((goal) => <GoalRow key={goal.goal_id} goal={goal} />)}
              </ul>
            )}
          </div>

          {(activity.recipe_runs.length > 0 || activity.completed_work.length > 0) && (
            <details className="mt-4 text-xs text-ink-soft dark:text-ink-soft-dark">
              <summary className="cursor-pointer">Completed today</summary>
              <div className="mt-2 space-y-3">
                {activity.recipe_runs.length > 0 && (
                  <ul className="space-y-1.5">
                    {activity.recipe_runs.slice(0, 5).map((recipe) => (
                      <li key={recipe.instance_id}>
                        {recipe.recipe_title} · {recipe.run ? stateLabel(recipe.run.state) : "created"}
                        {recipe.run ? ` · ${recipe.run.steps_attempted} step${recipe.run.steps_attempted === 1 ? "" : "s"}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {activity.completed_work.length > 0 && (
                  <ul className="space-y-1.5 text-ink-faint dark:text-ink-faint-dark">
                    {activity.completed_work.slice(0, 8).map((item, index) => (
                      <li key={`${item.execution_id ?? "completed"}-${index}`}>
                        ✓ {item.action} · verified
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
