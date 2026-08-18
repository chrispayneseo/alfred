import type { ReactNode } from "react";
import { AppLockSettings } from "../components/AppLockSettings";
import { DataControls } from "../components/DataControls";
import { GoogleAccountsSettings } from "../components/GoogleAccountsSettings";
import { LeedsTicketSettings } from "../components/LeedsTicketSettings";
import { ModelCostDashboard } from "../components/ModelCostDashboard";
import { NewsTopicSettings } from "../components/NewsTopicSettings";
import { PermissionsTrust } from "../components/PermissionsTrust";
import { ProjectGroupingSettings } from "../components/ProjectGroupingSettings";
import { RecurringTaskSettings } from "../components/RecurringTaskSettings";
import { Screen } from "../components/Screen";
import { WeeklyDigestSettings } from "../components/WeeklyDigestSettings";
import { useActiveSection } from "../hooks/useActiveSection";

interface SettingsSection {
  id: string;
  label: string;
}

// Below `lg`, these five just become section headings in one continuous
// scroll (unchanged from before this fix — mobile never had a section nav
// and doesn't get one now). At `lg+`, they back the sticky index sidebar
// in the render below.
const SECTIONS: SettingsSection[] = [
  { id: "account-security", label: "Account & Security" },
  { id: "automations", label: "Automations" },
  { id: "usage", label: "Usage" },
  { id: "privacy", label: "Privacy" },
  { id: "data-management", label: "Data Management" },
];
const SECTION_IDS = SECTIONS.map((s) => s.id);

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-sm font-medium text-ink dark:text-ink-dark">{children}</h2>;
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
      {children}
    </h3>
  );
}

export function SettingsScreen() {
  const active = useActiveSection(SECTION_IDS);

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <Screen title="Settings">
      <div className="lg:flex lg:items-start lg:gap-10">
        <nav className="hidden lg:sticky lg:top-8 lg:block lg:w-44 lg:shrink-0" aria-label="Settings sections">
          <ul className="space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => jumpTo(s.id)}
                  className={`block w-full rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
                    active === s.id
                      ? "bg-paper-raised text-ink dark:bg-paper-raised-dark dark:text-ink-dark"
                      : "text-ink-faint hover:text-ink-soft dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                  }`}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <section id="account-security" className="mb-8 scroll-mt-6">
            <SectionHeading>Account &amp; Security</SectionHeading>
            <div className="mb-6">
              <SubHeading>App Lock</SubHeading>
              <AppLockSettings />
            </div>
            <div>
              <SubHeading>Google accounts</SubHeading>
              <GoogleAccountsSettings />
            </div>
          </section>

          <section id="automations" className="mb-8 scroll-mt-6">
            <SectionHeading>Automations</SectionHeading>
            <div className="mb-6">
              <SubHeading>Weekly digest</SubHeading>
              <WeeklyDigestSettings />
            </div>
            <div className="mb-6">
              <SubHeading>Recurring tasks</SubHeading>
              <RecurringTaskSettings />
            </div>
            <div className="mb-6">
              <SubHeading>Project groupings</SubHeading>
              <ProjectGroupingSettings />
            </div>
            <div className="mb-6">
              <SubHeading>News feed topics</SubHeading>
              <NewsTopicSettings />
            </div>
            <div>
              <SubHeading>Leeds ticket windows</SubHeading>
              <LeedsTicketSettings />
            </div>
          </section>

          <section id="usage" className="mb-8 scroll-mt-6">
            <SectionHeading>Usage</SectionHeading>
            <SubHeading>Model cost</SubHeading>
            <ModelCostDashboard />
          </section>

          <section id="privacy" className="mb-8 scroll-mt-6">
            <SectionHeading>Privacy</SectionHeading>
            <SubHeading>What Alfred can do</SubHeading>
            <PermissionsTrust />
          </section>

          <section id="data-management" className="scroll-mt-6">
            <SectionHeading>Data Management</SectionHeading>
            <SubHeading>Your data</SubHeading>
            <DataControls />
          </section>
        </div>
      </div>
    </Screen>
  );
}
