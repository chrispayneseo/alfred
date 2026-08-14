import { AppLockSettings } from "../components/AppLockSettings";
import { DataControls } from "../components/DataControls";
import { GoogleAccountsSettings } from "../components/GoogleAccountsSettings";
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
          What Alfred can access
        </h2>
        <ul className="space-y-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">
          <li>Notion — your workspace is the source of truth; Alfred reads and writes Tasks, Notes, and Inbox there.</li>
          <li>Google Calendar — read-only, on every connected account.</li>
          <li>
            Gmail — read-only, plus creating drafts for your review, on every connected account. Alfred never sends
            email on your behalf.
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
