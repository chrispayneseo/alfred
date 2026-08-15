import type { CalendarEventRecord } from "../google/calendar.js";
import type { CalendarExtraction } from "./extract.js";
import { findDuplicate, indexEventsByDate } from "./duplicates.js";

export interface ReviewItem {
  id: string;
  kind: "single" | "recurring" | "unclear";
  title: string;
  /** YYYY-MM-DD, or null for an unclear item whose day couldn't be read. */
  date: string | null;
  /** YYYY-MM-DD, inclusive — set only for a multi-day single item. */
  endDate: string | null;
  /** HH:MM 24h, or null for all-day. */
  time: string | null;
  /** RRULE BYDAY code (MO/TU/.../SU) — set only for kind "recurring". */
  weekday?: string;
  /** Every occurrence date visible on the page — set only for kind "recurring". */
  dates?: string[];
  duplicate: boolean;
  /** Title of the existing event that looked like a match, for display. */
  duplicateOf?: string;
  /** kind "unclear" only. */
  unclearReason?: string;
}

/** Every date an extraction touches, single-day items, date-range items,
 * and every recurring-group occurrence — used to fetch a tight enough
 * existing-events window to check for duplicates. */
export function extractionDateRange(extraction: CalendarExtraction): { start: string; end: string } | undefined {
  const dates: string[] = [];
  for (const item of extraction.items) {
    dates.push(item.date);
    if (item.endDate) dates.push(item.endDate);
  }
  for (const group of extraction.recurringGroups) dates.push(...group.dates);
  for (const item of extraction.unclear) if (item.date) dates.push(item.date);

  if (dates.length === 0) return undefined;
  dates.sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `rv-${Date.now()}-${counter}`;
}

/** Turns a raw extraction into the reviewable list the frontend shows,
 * flagging anything that looks like it's already on the calendar. Never
 * auto-approves anything — that decision always happens in the UI. */
export function buildReviewItems(extraction: CalendarExtraction, existingEvents: CalendarEventRecord[]): ReviewItem[] {
  const byDate = indexEventsByDate(existingEvents);
  const result: ReviewItem[] = [];

  for (const item of extraction.items) {
    const match = findDuplicate(byDate, item.date, item.title);
    result.push({
      id: nextId(),
      kind: "single",
      title: item.title,
      date: item.date,
      endDate: item.endDate,
      time: item.time,
      duplicate: Boolean(match),
      duplicateOf: match?.title,
    });
  }

  for (const group of extraction.recurringGroups) {
    let matchTitle: string | undefined;
    for (const date of group.dates) {
      const match = findDuplicate(byDate, date, group.title);
      if (match) {
        matchTitle = match.title;
        break;
      }
    }
    result.push({
      id: nextId(),
      kind: "recurring",
      title: group.title,
      date: group.dates[0],
      endDate: null,
      time: group.time,
      weekday: group.weekday,
      dates: group.dates,
      duplicate: Boolean(matchTitle),
      duplicateOf: matchTitle,
    });
  }

  for (const item of extraction.unclear) {
    result.push({
      id: nextId(),
      kind: "unclear",
      title: "",
      date: item.date,
      endDate: null,
      time: null,
      duplicate: false,
      unclearReason: `${item.reason}${item.partialText ? ` — "${item.partialText}"` : ""}`,
    });
  }

  return result;
}
