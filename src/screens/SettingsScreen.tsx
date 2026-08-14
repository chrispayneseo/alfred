import { AppLockSettings } from "../components/AppLockSettings";
import { DataControls } from "../components/DataControls";
import { GoogleAccountsSettings } from "../components/GoogleAccountsSettings";
import { RecurringTaskSettings } from "../components/RecurringTaskSettings";
import { Screen } from "../components/Screen";
import { WeeklyDigestSettings } from "../components/WeeklyDigestSettings";

export function SettingsScreen() {
  return (
    <Screen title="Settings">
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          App Lock
        </h2>
        <AppLockSettings />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Google accounts
        </h2>
        <GoogleAccountsSettings />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Weekly digest
        </h2>
        <WeeklyDigestSettings />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Recurring tasks
        </h2>
        <RecurringTaskSettings />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          What Alfred can access
        </h2>
        <ul className="space-y-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">
          <li>Notion — your workspace is the source of truth; Alfred reads and writes Tasks, Notes, and Inbox there.</li>
          <li>
            Google Calendar — read on every connected account, plus creating events when you explicitly ask Chat
            to and confirm the proposed details. Alfred never creates an event without that confirmation.
          </li>
          <li>
            Gmail — read-only, plus creating drafts for your review, on every connected account. Alfred never sends
            email on your behalf.
          </li>
          <li>
            CoachPlan — read-only, scoped to your team's upcoming training sessions and matches. Alfred never writes
            back to CoachPlan.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Data & Privacy
        </h2>
        <DataControls />
      </section>
    </Screen>
  );
}
