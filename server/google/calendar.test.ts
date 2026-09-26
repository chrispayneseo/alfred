import assert from "node:assert/strict";
import test from "node:test";
import type { calendar_v3 } from "googleapis";
import {
  eventIntersectsRange,
  getCalendarDateRange,
  getTodayRange,
  getTomorrowRange,
  mapCalendarEvent,
  type CalendarEventRecord,
} from "./calendar.js";

const ACCOUNT = "calendar@example.com";

function allDay(id: string, start: string, end: string): CalendarEventRecord {
  const event: calendar_v3.Schema$Event = { id, summary: id, start: { date: start }, end: { date: end } };
  const mapped = mapCalendarEvent(event, ACCOUNT);
  assert.ok(mapped);
  return mapped;
}

function timed(id: string, start: string, end: string): CalendarEventRecord {
  const event: calendar_v3.Schema$Event = { id, summary: id, start: { dateTime: start }, end: { dateTime: end } };
  const mapped = mapCalendarEvent(event, ACCOUNT);
  assert.ok(mapped);
  return mapped;
}

test("maps Google all-day events as date-only spans", () => {
  const event = allDay("Cookie flea", "2026-09-27", "2026-09-28");
  assert.equal(event.allDay, true);
  assert.equal(event.start, "2026-09-27");
  assert.equal(event.end, "2026-09-28");
});

test("26 September 2026: tomorrow all-day events are not classified as today in London BST", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  const today = getTodayRange(now);
  const tomorrow = getTomorrowRange(now);
  const cookieFlea = allDay("Cookie flea", "2026-09-27", "2026-09-28");
  const familyMeeting = allDay("Family Meeting", "2026-09-27", "2026-09-28");

  assert.deepEqual([today.startDate, today.endDate], ["2026-09-26", "2026-09-27"]);
  assert.equal(today.start.toISOString(), "2026-09-25T23:00:00.000Z");
  assert.equal(today.end.toISOString(), "2026-09-26T23:00:00.000Z");
  assert.equal(eventIntersectsRange(cookieFlea, today), false);
  assert.equal(eventIntersectsRange(familyMeeting, today), false);
  assert.equal(eventIntersectsRange(cookieFlea, tomorrow), true);
  assert.equal(eventIntersectsRange(familyMeeting, tomorrow), true);
});

test("an all-day event on today is included exactly in today's date range", () => {
  const today = getTodayRange(new Date("2026-09-26T12:00:00.000Z"));
  assert.equal(eventIntersectsRange(allDay("today", "2026-09-26", "2026-09-27"), today), true);
});

test("all-day end.date is exclusive", () => {
  const event = allDay("one day", "2026-09-27", "2026-09-28");
  assert.equal(eventIntersectsRange(event, getCalendarDateRange("2026-09-27", "2026-09-28")), true);
  assert.equal(eventIntersectsRange(event, getCalendarDateRange("2026-09-28", "2026-09-29")), false);
});

test("multi-day all-day events occupy each date before their exclusive end", () => {
  const event = allDay("trip", "2026-09-27", "2026-09-30");
  for (const date of ["2026-09-27", "2026-09-28", "2026-09-29"]) {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.equal(eventIntersectsRange(event, getCalendarDateRange(date, next.toISOString().slice(0, 10))), true);
  }
  assert.equal(eventIntersectsRange(event, getCalendarDateRange("2026-09-30", "2026-10-01")), false);
});

test("London date boundaries remain correct across the BST to GMT transition", () => {
  const range = getCalendarDateRange("2026-10-25", "2026-10-26");
  assert.equal(range.start.toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(eventIntersectsRange(allDay("transition", "2026-10-25", "2026-10-26"), range), true);
});

test("timed events still use instant overlap semantics", () => {
  const range = getCalendarDateRange("2026-09-27", "2026-09-28");
  assert.equal(eventIntersectsRange(timed("breakfast", "2026-09-27T09:00:00+01:00", "2026-09-27T10:00:00+01:00"), range), true);
  assert.equal(eventIntersectsRange(timed("previous day", "2026-09-26T22:00:00Z", "2026-09-26T22:30:00Z"), range), false);
});
