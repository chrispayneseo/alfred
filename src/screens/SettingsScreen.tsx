import { AppLockSettings } from "../components/AppLockSettings";
import { DataControls } from "../components/DataControls";
import { Screen } from "../components/Screen";

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
          What Alfred can access
        </h2>
        <ul className="space-y-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">
          <li>Notion — your workspace is the source of truth; Alfred reads and writes Tasks, Notes, and Inbox there.</li>
          <li>Google Calendar — read-only.</li>
          <li>Gmail — read-only, plus creating drafts for your review. Alfred never sends email on your behalf.</li>
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
