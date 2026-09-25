import { useEffect, useState } from "react";
import {
  fetchProactiveDeliveryStatus,
  fetchProactiveSettings,
  updateProactiveSettings,
  type ProactiveDeliveryStatus,
  type ProactiveSettings as ProactiveSettingsState,
} from "../integrations/proactive/api";

const POLL_OPTIONS = [
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 1800, label: "Every 30 minutes" },
  { value: 3600, label: "Every hour" },
];

const COOLDOWN_OPTIONS = [
  { value: 0, label: "No cooldown" },
  { value: 60, label: "1 hour" },
  { value: 180, label: "3 hours" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
];

export function ProactiveSettings() {
  const [settings, setSettings] = useState<ProactiveSettingsState>();
  const [draft, setDraft] = useState<ProactiveSettingsState>();
  const [delivery, setDelivery] = useState<ProactiveDeliveryStatus | null>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchProactiveSettings(),
      fetchProactiveDeliveryStatus().catch(() => null),
    ])
      .then(([value, deliveryState]) => {
        const normalised = { ...value, push_enabled: Boolean(value.push_enabled) };
        setSettings(normalised);
        setDraft(normalised);
        setDelivery(deliveryState);
        setError(undefined);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load proactive settings."))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const updated = await updateProactiveSettings({
        enabled: draft.enabled,
        poll_seconds: draft.poll_seconds,
        quiet_start: draft.quiet_start,
        quiet_end: draft.quiet_end,
        min_priority: draft.min_priority,
        cooldown_minutes: draft.cooldown_minutes,
        morning_brief_enabled: draft.morning_brief_enabled,
        morning_brief_time: draft.morning_brief_time,
        push_enabled: draft.push_enabled,
      });
      const normalised = { ...updated, push_enabled: Boolean(updated.push_enabled) };
      setSettings(normalised);
      setDraft(normalised);
      setDelivery(await fetchProactiveDeliveryStatus().catch(() => null));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save proactive settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading Alfred's proactive controls…</p>;
  }

  if (!draft) {
    return (
      <div className="rounded-xl border border-line p-3 dark:border-line-dark">
        <p role="alert" className="text-sm text-ink-soft dark:text-ink-soft-dark">{error ?? "Proactive controls unavailable."}</p>
      </div>
    );
  }

  const comparable = (value: ProactiveSettingsState) => ({
    enabled: value.enabled,
    poll_seconds: value.poll_seconds,
    quiet_start: value.quiet_start,
    quiet_end: value.quiet_end,
    min_priority: value.min_priority,
    cooldown_minutes: value.cooldown_minutes,
    morning_brief_enabled: value.morning_brief_enabled,
    morning_brief_time: value.morning_brief_time,
    push_enabled: value.push_enabled,
  });
  const dirty = settings ? JSON.stringify(comparable(settings)) !== JSON.stringify(comparable(draft)) : false;
  const pushUnavailable = delivery === null || delivery === undefined || !delivery.configured;

  return (
    <div className="rounded-2xl border border-line p-4 dark:border-line-dark">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink dark:text-ink-dark">Local proactive assistant</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint dark:text-ink-faint-dark">
            Controls observation, briefing and tightly limited phone nudges from the Dell.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-ink-soft dark:text-ink-soft-dark">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-xs text-ink-soft dark:text-ink-soft-dark">
          Check for changes
          <select
            value={draft.poll_seconds}
            onChange={(event) => setDraft({ ...draft, poll_seconds: Number(event.target.value) })}
            className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink dark:border-line-dark dark:text-ink-dark"
          >
            {POLL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>

        <label className="text-xs text-ink-soft dark:text-ink-soft-dark">
          Minimum priority to surface
          <input
            type="number"
            min={0}
            max={100}
            value={draft.min_priority}
            onChange={(event) => setDraft({ ...draft, min_priority: Number(event.target.value) })}
            className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink dark:border-line-dark dark:text-ink-dark"
          />
        </label>

        <label className="text-xs text-ink-soft dark:text-ink-soft-dark">
          Quiet hours start
          <input
            type="time"
            value={draft.quiet_start}
            onChange={(event) => setDraft({ ...draft, quiet_start: event.target.value })}
            className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink dark:border-line-dark dark:text-ink-dark"
          />
        </label>

        <label className="text-xs text-ink-soft dark:text-ink-soft-dark">
          Quiet hours end
          <input
            type="time"
            value={draft.quiet_end}
            onChange={(event) => setDraft({ ...draft, quiet_end: event.target.value })}
            className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink dark:border-line-dark dark:text-ink-dark"
          />
        </label>

        <label className="text-xs text-ink-soft dark:text-ink-soft-dark">
          Interruption cooldown
          <select
            value={draft.cooldown_minutes}
            onChange={(event) => setDraft({ ...draft, cooldown_minutes: Number(event.target.value) })}
            className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink dark:border-line-dark dark:text-ink-dark"
          >
            {COOLDOWN_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>

        <div className="rounded-xl border border-line px-3 py-2 dark:border-line-dark">
          <label className="flex items-center justify-between gap-3 text-xs text-ink-soft dark:text-ink-soft-dark">
            Morning brief
            <input
              type="checkbox"
              checked={draft.morning_brief_enabled}
              onChange={(event) => setDraft({ ...draft, morning_brief_enabled: event.target.checked })}
            />
          </label>
          <input
            type="time"
            aria-label="Morning brief time"
            disabled={!draft.morning_brief_enabled}
            value={draft.morning_brief_time}
            onChange={(event) => setDraft({ ...draft, morning_brief_time: event.target.value })}
            className="mt-2 block w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink disabled:opacity-40 dark:border-line-dark dark:text-ink-dark"
          />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-line p-3 dark:border-line-dark">
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-xs font-medium text-ink dark:text-ink-dark">Generic phone nudges</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint dark:text-ink-faint-dark">
              Alfred may send “something worth checking” only after the interruption policy allows it. Email subjects, calendar titles, task names and summaries never go in the push.
            </span>
          </span>
          <input
            type="checkbox"
            checked={draft.push_enabled}
            disabled={pushUnavailable && !draft.push_enabled}
            onChange={(event) => setDraft({ ...draft, push_enabled: event.target.checked })}
            aria-label="Enable generic phone nudges"
          />
        </label>
        <p className="mt-2 text-[11px] text-ink-faint dark:text-ink-faint-dark">
          {delivery?.configured
            ? `ntfy channel ready · ${delivery.delivered_count} proactive nudge${delivery.delivered_count === 1 ? "" : "s"} delivered`
            : delivery === null
              ? "Delivery status unavailable until the Dell Core is updated."
              : "No valid ntfy topic is configured on the Dell yet."}
        </p>
      </div>

      {error && <p role="alert" className="mt-3 text-xs text-claude">{error}</p>}
      {saved && <p className="mt-3 text-xs text-ink-soft dark:text-ink-soft-dark">Saved on the Dell and applied immediately.</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark"
        >
          {saving ? "Saving…" : "Save proactive settings"}
        </button>
        {settings?.source === "environment_defaults" && (
          <span className="text-[11px] text-ink-faint dark:text-ink-faint-dark">Currently using .env defaults</span>
        )}
      </div>
    </div>
  );
}
