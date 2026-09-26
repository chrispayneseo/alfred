import { Link } from "react-router-dom";
import { AgentInboxScreen } from "./AgentInboxScreen";

export function ActivityScreen() {
  return <div>
    <div className="mx-auto max-w-[90rem] px-5 pt-[max(1rem,env(safe-area-inset-top))] lg:px-10">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-accent">Activity</p>
        <Link to="/feed" className="text-xs text-ink-faint hover:text-ink dark:text-ink-faint-dark">View feed</Link>
      </div>
      <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">Approvals, agent work and anything that needs your attention.</p>
    </div>
    <AgentInboxScreen />
  </div>;
}
