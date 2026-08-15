import { useState } from "react";
import {
  createCalendarPhotoEvents,
  type ApprovedItem,
  type CreateResultItem,
  type ExtractResult,
  type ReviewItem,
} from "../integrations/calendarPhoto/api";

type Status = "pending" | "approved" | "deleted";
type RecurrenceOption = "none" | "weekly" | "monthly" | "yearly";

interface LocalItem extends ReviewItem {
  status: Status;
  person: string;
  recurrence: RecurrenceOption;
}

const PEOPLE = ["Jo", "Jack", "Chris", "Evie", "Family"];
const WEEKDAY_LABEL: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };

function formatDate(iso: string | null): string {
  if (!iso) return "Unknown date";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function recurrenceLabel(item: LocalItem): string {
  if (item.recurrence === "monthly") return "Monthly";
  if (item.recurrence === "yearly") return "Yearly";
  if (item.recurrence === "weekly") {
    const weekday = item.weekday
      ? (WEEKDAY_LABEL[item.weekday] ?? item.weekday)
      : item.date
        ? new Date(`${item.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long" })
        : undefined;
    return weekday ? `Every ${weekday}` : "Weekly";
  }
  return "Not repeating";
}

function summaryLine(item: LocalItem): string {
  if (item.kind === "recurring") {
    if (item.recurrence === "none") {
      return `${item.dates?.length ?? 0} occurrences, added individually${item.time ? ` · ${item.time}` : ""}`;
    }
    return `${recurrenceLabel(item)}${item.time ? ` · ${item.time}` : ""}`;
  }
  const dateLabel = item.endDate ? `${formatDate(item.date)} – ${formatDate(item.endDate)}` : formatDate(item.date);
  return `${dateLabel}${item.time ? ` · ${item.time}` : ""}`;
}

function toApproved(item: LocalItem): ApprovedItem {
  const person = item.person.trim() || undefined;
  const recurrence = item.recurrence === "none" ? undefined : item.recurrence;
  if (item.kind === "recurring") {
    return { kind: "recurring", title: item.title, date: item.date!, endDate: null, time: item.time, person, recurrence, dates: item.dates };
  }
  return { kind: "single", title: item.title, date: item.date!, endDate: item.endDate, time: item.time, person, recurrence };
}

function ItemCard({
  item,
  onChange,
  onApprove,
  onDelete,
}: {
  item: LocalItem;
  onChange: (patch: Partial<LocalItem>) => void;
  onApprove: () => void;
  onDelete: () => void;
}) {
  const canApprove = item.title.trim().length > 0 && Boolean(item.date);
  const selectClass =
    "rounded-lg border border-line bg-paper-raised px-2 py-1 text-xs text-ink outline-none dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark";

  return (
    <li
      className={`rounded-2xl border px-4 py-3.5 ${
        item.status === "approved"
          ? "border-ink/30 bg-paper-raised dark:border-ink-dark/30 dark:bg-paper-raised-dark"
          : "border-line dark:border-line-dark"
      }`}
    >
      {item.duplicate && (
        <p className="mb-2 text-[11px] font-medium text-claude">
          Possibly already on the calendar{item.duplicateOf ? ` — "${item.duplicateOf}"` : ""}
        </p>
      )}
      {item.kind === "unclear" && (
        <p className="mb-2 text-[11px] text-ink-faint dark:text-ink-faint-dark">Unclear: {item.unclearReason}</p>
      )}

      <input
        value={item.title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder={item.kind === "unclear" ? "What is this?" : undefined}
        className="w-full rounded-lg border border-line bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
      />

      {item.kind === "recurring" ? (
        <p className="mt-2 text-xs text-ink-faint dark:text-ink-faint-dark">{summaryLine(item)}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={item.date ?? ""}
            onChange={(e) => onChange({ date: e.target.value || null })}
            className="rounded-lg border border-line bg-paper-raised px-2 py-1 text-xs text-ink outline-none dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
          />
          {item.kind === "single" && (
            <>
              <span className="text-xs text-ink-faint dark:text-ink-faint-dark">to</span>
              <input
                type="date"
                value={item.endDate ?? ""}
                onChange={(e) => onChange({ endDate: e.target.value || null })}
                className="rounded-lg border border-line bg-paper-raised px-2 py-1 text-xs text-ink outline-none dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
              />
            </>
          )}
          <input
            type="time"
            value={item.time ?? ""}
            onChange={(e) => onChange({ time: e.target.value || null })}
            placeholder="All day"
            className="rounded-lg border border-line bg-paper-raised px-2 py-1 text-xs text-ink outline-none dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
          />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select value={item.person} onChange={(e) => onChange({ person: e.target.value })} className={selectClass}>
          <option value="">Who</option>
          {PEOPLE.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={item.recurrence}
          onChange={(e) => onChange({ recurrence: e.target.value as RecurrenceOption })}
          className={selectClass}
        >
          <option value="none">Not repeating</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
      </div>

      <div className="mt-3 flex items-center gap-3">
        {item.status === "approved" ? (
          <span className="text-xs font-medium text-ink dark:text-ink-dark">Approved</span>
        ) : (
          <button
            onClick={onApprove}
            disabled={!canApprove}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
          >
            Approve
          </button>
        )}
        <button
          onClick={onDelete}
          className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-claude dark:text-ink-faint-dark"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export function CalendarScanReview({ result, onDone, onCancel }: { result: ExtractResult; onDone: () => void; onCancel: () => void }) {
  const [items, setItems] = useState<LocalItem[]>(
    result.items.map((i) => ({ ...i, status: "pending", person: "", recurrence: i.kind === "recurring" ? "weekly" : "none" }))
  );
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [results, setResults] = useState<CreateResultItem[]>();

  function update(id: string, patch: Partial<LocalItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  function approve(id: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "approved" } : i)));
  }

  function remove(id: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "deleted" } : i)));
  }

  const visible = items.filter((i) => i.status !== "deleted");
  const unclear = visible.filter((i) => i.kind === "unclear");
  const duplicates = visible.filter((i) => i.kind !== "unclear" && i.duplicate);
  const clear = visible.filter((i) => i.kind !== "unclear" && !i.duplicate);
  const approved = visible.filter((i) => i.status === "approved");

  function approveAllClear() {
    setItems((prev) => prev.map((i) => (clear.some((c) => c.id === i.id) ? { ...i, status: "approved" } : i)));
  }

  async function handleSubmit() {
    if (approved.length === 0) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const { results: res } = await createCalendarPhotoEvents(approved.map(toApproved));
      setResults(res);
      if (res.every((r) => r.ok)) {
        setTimeout(onDone, 1500);
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Something went wrong writing to your calendar.");
    } finally {
      setCreating(false);
    }
  }

  if (results) {
    const failed = results.filter((r) => !r.ok);
    const succeeded = results.filter((r) => r.ok);
    return (
      <div className="flex flex-col gap-3">
        {succeeded.length > 0 && (
          <p className="text-sm text-ink dark:text-ink-dark">
            Added {succeeded.length} event{succeeded.length === 1 ? "" : "s"} to your calendar.
          </p>
        )}
        {failed.length > 0 && (
          <div className="rounded-2xl border border-claude/40 px-4 py-3">
            <p className="mb-2 text-sm text-claude">{failed.length} couldn't be created:</p>
            <ul className="space-y-1">
              {failed.map((f, i) => (
                <li key={i} className="text-xs text-ink-soft dark:text-ink-soft-dark">
                  {f.title} ({f.date}) — {f.error}
                </li>
              ))}
            </ul>
            <button
              onClick={() => setResults(undefined)}
              className="mt-3 rounded-full border border-line px-3.5 py-1.5 text-xs font-medium text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
            >
              Back to review
            </button>
          </div>
        )}
        {failed.length === 0 && (
          <button onClick={onDone} className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper dark:bg-ink-dark dark:text-paper-dark">
            Done
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
        {result.monthYear} — review before adding to your calendar:
      </p>

      {unclear.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
            Unclear — needs your input
          </h3>
          <ul className="space-y-3">
            {unclear.map((item) => (
              <ItemCard key={item.id} item={item} onChange={(p) => update(item.id, p)} onApprove={() => approve(item.id)} onDelete={() => remove(item.id)} />
            ))}
          </ul>
        </section>
      )}

      {duplicates.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
            Possible duplicates
          </h3>
          <ul className="space-y-3">
            {duplicates.map((item) => (
              <ItemCard key={item.id} item={item} onChange={(p) => update(item.id, p)} onApprove={() => approve(item.id)} onDelete={() => remove(item.id)} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Entries</h3>
          {clear.some((i) => i.status === "pending") && (
            <button onClick={approveAllClear} className="text-xs text-ink-soft underline underline-offset-2 dark:text-ink-soft-dark">
              Approve all clear items
            </button>
          )}
        </div>
        {clear.length === 0 ? (
          <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing else found.</p>
        ) : (
          <ul className="space-y-3">
            {clear.map((item) => (
              <ItemCard key={item.id} item={item} onChange={(p) => update(item.id, p)} onApprove={() => approve(item.id)} onDelete={() => remove(item.id)} />
            ))}
          </ul>
        )}
      </section>

      {createError && <p className="text-xs text-claude">{createError}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSubmit}
          disabled={creating || approved.length === 0}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
        >
          {creating ? "Adding…" : `Add ${approved.length || ""} to calendar`}
        </button>
        <button
          onClick={onCancel}
          disabled={creating}
          className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
