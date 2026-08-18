import { useEffect, useState } from "react";
import {
  fetchLeedsTicketSettings,
  setLeedsTicketSettings,
  type LeedsTicketSettings as LeedsTicketSettingsType,
  type MembershipTier,
} from "../integrations/leedsTickets/api";

const TIER_OPTIONS: { value: MembershipTier; label: string }[] = [
  { value: "base", label: "My Leeds Members" },
  { value: "plus", label: "My Leeds+" },
  { value: "priority", label: "My Leeds Priority" },
];

export function LeedsTicketSettings() {
  const [settings, setSettings] = useState<LeedsTicketSettingsType>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchLeedsTicketSettings()
      .then(setSettings)
      .catch(() => setError("Couldn't load ticket settings right now."));
  }, []);

  async function save(next: LeedsTicketSettingsType) {
    setSettings(next);
    setSaving(true);
    setError(undefined);
    try {
      await setLeedsTicketSettings(next);
    } catch {
      setError("Couldn't save that change.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>;

  return (
    <div>
      <p className="mb-3 text-xs text-ink-soft dark:text-ink-soft-dark">
        Alfred scans your synced Gmail for Leeds United ticket-window emails and only surfaces sale/ballot phases
        your membership tier is eligible for.
      </p>

      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-ink dark:text-ink-dark">Your membership tier</label>
        <div className="flex gap-2">
          {TIER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => save({ ...settings, tier: opt.value })}
              disabled={saving}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                settings.tier === opt.value
                  ? "border-ink bg-ink text-paper dark:border-ink-dark dark:bg-ink-dark dark:text-paper-dark"
                  : "border-line text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-ink dark:text-ink-dark">Early nudge (hours before)</label>
          <input
            type="number"
            min={1}
            value={settings.earlyNudgeHours}
            onChange={(e) => setSettings({ ...settings, earlyNudgeHours: Number(e.target.value) })}
            onBlur={() => save(settings)}
            className="w-20 rounded-xl border border-line bg-paper-raised px-3 py-1.5 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-ink dark:text-ink-dark">Closer nudge (hours before)</label>
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={settings.closeNudgeHours}
            onChange={(e) => setSettings({ ...settings, closeNudgeHours: Number(e.target.value) })}
            onBlur={() => save(settings)}
            className="w-20 rounded-xl border border-line bg-paper-raised px-3 py-1.5 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-claude">{error}</p>}
    </div>
  );
}
