import assert from "node:assert/strict";
import test from "node:test";
import { eventOverlapsRange, getDayRange, getTodayRange, getTomorrowRange, type CalendarEventRecord } from "./calendar.js";

function event(start: string, end: string, allDay = true): CalendarEventRecord {
  return { id: "1", title: "Family: Cookie flea", start, end, allDay, accountEmail: "test@example.com" };
}

test("26 September 2026: tomorrow's one-day all-day events occur only tomorrow", () => {
  const now = new Date("2026-09-26T19:53:00Z"); // 20:53 BST
  const today = getTodayRange(now);
  const tomorrow = getTomorrowRange(now);
  for (const title of ["Family: Cookie flea", "Family: Family Meeting"]) {
    const item = { ...event("2026-09-27", "2026-09-28"), title };
    assert.equal(eventOverlapsRange(item, today), false);
    assert.equal(eventOverlapsRange(item, tomorrow), true);
  }
  assert.equal(today.start.toISOString(), "2026-09-25T23:00:00.000Z");
  assert.equal(tomorrow.start.toISOString(), "2026-09-26T23:00:00.000Z");
});

test("today's all-day event does not spill into tomorrow at exclusive end.date", () => {
  const item = event("2026-09-26", "2026-09-27");
  assert.equal(eventOverlapsRange(item, getDayRange("2026-09-26")), true);
  assert.equal(eventOverlapsRange(item, getDayRange("2026-09-27")), false);
});

test("multi-day all-day events include each calendar day except exclusive end.date", () => {
  const item = event("2026-09-27", "2026-09-30");
  for (const date of ["2026-09-27", "2026-09-28", "2026-09-29"])
    assert.equal(eventOverlapsRange(item, getDayRange(date)), true);
  for (const date of ["2026-09-26", "2026-09-30"])
    assert.equal(eventOverlapsRange(item, getDayRange(date)), false);
});

test("London midnight and date classification survive BST to GMT transition", () => {
  const before = getDayRange("2026-10-25");
  const after = getDayRange("2026-10-26");
  assert.equal(before.start.toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(before.end.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(after.start.toISOString(), before.end.toISOString());
  assert.equal(eventOverlapsRange(event("2026-10-26", "2026-10-27"), before), false);
  assert.equal(eventOverlapsRange(event("2026-10-25", "2026-10-26"), before), true);
});

test("timed events use instant overlap and retain London day membership", () => {
  const item = event("2026-09-27T00:30:00+01:00", "2026-09-27T01:30:00+01:00", false);
  assert.equal(eventOverlapsRange(item, getDayRange("2026-09-26")), false);
  assert.equal(eventOverlapsRange(item, getDayRange("2026-09-27")), true);
  const spanning = event("2026-09-26T23:30:00+01:00", "2026-09-27T00:30:00+01:00", false);
  assert.equal(eventOverlapsRange(spanning, getDayRange("2026-09-26")), true);
  assert.equal(eventOverlapsRange(spanning, getDayRange("2026-09-27")), true);
});
