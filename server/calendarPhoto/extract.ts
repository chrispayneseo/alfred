import { z } from "zod";
import type { LlmEnv } from "../llm/env.js";
import { routedVisionComplete } from "../llm/routedComplete.js";

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const ExtractedItemSchema = z.object({
  date: z.string(),
  endDate: z.string().nullable(),
  time: z.string().nullable(),
  title: z.string(),
});

const RecurringGroupSchema = z.object({
  weekday: z.enum(WEEKDAY_CODES),
  title: z.string(),
  time: z.string().nullable(),
  dates: z.array(z.string()).min(2),
});

const UnclearItemSchema = z.object({
  date: z.string().nullable(),
  partialText: z.string(),
  reason: z.string(),
});

const CalendarExtractionSchema = z.object({
  monthYear: z.string(),
  items: z.array(ExtractedItemSchema),
  recurringGroups: z.array(RecurringGroupSchema),
  unclear: z.array(UnclearItemSchema),
});

export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;
export type RecurringGroup = z.infer<typeof RecurringGroupSchema>;
export type UnclearItem = z.infer<typeof UnclearItemSchema>;
export type CalendarExtraction = z.infer<typeof CalendarExtractionSchema>;

const EXTRACTION_SYSTEM_PROMPT = `You read a photo of a handwritten wall/paper calendar page and extract every entry as structured data for a personal assistant app. Be careful and literal — this is read once and acted on, not double-checked by a human against the photo afterward for anything you mark as clear.

Steps:
1. Identify the month and year this calendar page represents from the page itself (a printed header, visible year, or other on-page context). Never assume the current month — read it from the photo. If genuinely not visible anywhere on the page, make your best reasonable inference from context and still proceed, but note it's a guess in "monthYear".
2. Read every handwritten entry on the page. For each, resolve its day-of-month against the identified month/year into a full ISO date (YYYY-MM-DD).
3. If a single entry's handwriting or a drawn line visually spans multiple consecutive day cells (not just multiple words on one day), represent it as one item with both "date" (first day) and "endDate" (last day, inclusive) set — not as separate one-day items.
4. If an entry has a specific time written (e.g. "3pm", "15:00", "9:30am"), extract it as 24-hour "HH:MM". If no time is written, set "time" to null (all-day).
5. Look across the WHOLE visible page for the same title (or clearly the same activity) appearing on the same weekday across two or more different weeks (e.g. "training" on several different Tuesdays). Group these into "recurringGroups" instead of listing them as separate "items" — one group per distinct recurring activity, with every date it appears on listed in "dates". Do not put an entry in both "items" and "recurringGroups".
6. For anything you cannot read with real confidence — illegible handwriting, an ambiguous day, smudged text — do NOT guess a title or date. Put it in "unclear" instead, with whatever partial text you actually can make out in "partialText", the reason it's unclear, and "date" set to your best-guess date only if the DAY is legible even though other details aren't (otherwise null).

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{
  "monthYear": "a human-readable label, e.g. \\"August 2026\\"",
  "items": [{"date": "YYYY-MM-DD", "endDate": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "title": "..."}],
  "recurringGroups": [{"weekday": "MO"|"TU"|"WE"|"TH"|"FR"|"SA"|"SU", "title": "...", "time": "HH:MM"|null, "dates": ["YYYY-MM-DD", ...]}],
  "unclear": [{"date": "YYYY-MM-DD"|null, "partialText": "...", "reason": "..."}]
}
If the page has no legible entries at all, return empty arrays for items/recurringGroups/unclear rather than inventing anything.`;

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/** Sends the photo to a vision-capable routed model (Step 3's Claude/GPT
 * routing + fallback) and parses its structured extraction. Throws on a
 * malformed response — the caller (the /extract route) turns that into a
 * clear "couldn't read that photo, try again" rather than silently
 * returning nothing, since a parse failure here means the whole scan
 * failed, not that the page was blank. */
export async function extractCalendarPhoto(env: LlmEnv, imageBase64: string, mediaType: "image/jpeg" | "image/png" | "image/webp"): Promise<CalendarExtraction> {
  const raw = await routedVisionComplete(
    env,
    "extract structured calendar data as json from this photo",
    EXTRACTION_SYSTEM_PROMPT,
    "Extract every entry from this calendar photo as instructed.",
    imageBase64,
    mediaType,
    4096
  );

  const parsed = parseJsonLoose(raw);
  return CalendarExtractionSchema.parse(parsed);
}
