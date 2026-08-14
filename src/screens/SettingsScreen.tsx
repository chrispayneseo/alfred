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

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Data & Privacy
        </h2>
        <DataControls />
      </section>
    </Screen>
  );
}
