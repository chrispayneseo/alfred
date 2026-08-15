import type { CalendarEventRecord } from "../google/calendar.js";

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim();
}

/** Cheap deterministic similarity heuristic — same philosophy as
 * emailScan.ts's looksAutomated: no LLM call needed just to compare two
 * short titles. Exact match, substring match, or at least half the words
 * in common (Jaccard-ish over the word sets) all count as "similar enough
 * to flag as a possible duplicate," not "identical." */
export function titlesAreSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;

  const wa = new Set(na.split(/\s+/));
  const wb = new Set(nb.split(/\s+/));
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && intersection / union >= 0.5;
}

/** Existing events indexed by their calendar date (YYYY-MM-DD) — an
 * all-day event's `start` is already a bare date; a timed event's is an
 * ISO datetime, so this takes just the date portion either way. */
export function indexEventsByDate(events: CalendarEventRecord[]): Map<string, CalendarEventRecord[]> {
  const byDate = new Map<string, CalendarEventRecord[]>();
  for (const event of events) {
    const date = event.start.slice(0, 10);
    const list = byDate.get(date);
    if (list) list.push(event);
    else byDate.set(date, [event]);
  }
  return byDate;
}

/** Returns the first existing event on `date` whose title looks like the
 * same thing as `title`, if any. */
export function findDuplicate(
  byDate: Map<string, CalendarEventRecord[]>,
  date: string,
  title: string
): CalendarEventRecord | undefined {
  return byDate.get(date)?.find((event) => titlesAreSimilar(event.title, title));
}
