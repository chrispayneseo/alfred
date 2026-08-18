// Classifies a candidate school email (already narrowed by store.ts's
// sender+keyword prefilter) — mirrors emailScan.ts's shape (schema,
// parseJsonLoose, routedComplete, logModelCall) but with Evie's own output:
// relevant/not, any dated events, and one optional non-event action item.
import { z } from "zod";
import { logModelCall } from "../costTracking/callLog.js";
import type { Env } from "../db.js";
import type { LlmEnv } from "./env.js";
import { routedComplete } from "./routedComplete.js";

const EvieEventSchema = z.object({
  title: z.string(),
  date: z.string().describe("ISO date YYYY-MM-DD"),
  startTime: z.string().nullable().describe("24h HH:MM if a specific time is given, otherwise null for an all-day event"),
  endTime: z.string().nullable(),
  location: z.string().nullable(),
});

const EvieActionSchema = z.object({
  relevant: z
    .boolean()
    .describe(
      "True only if this email is genuinely about Evie Payne-Hewitt, her class 'Australia', Year 3, her teacher Mrs/Miss Pearson, or her Choir Club / Cooking Club — not a coincidental keyword match."
    ),
  events: z.array(EvieEventSchema).describe("Any dated events mentioned (trips, sports day, concerts, INSET days, club sessions). Empty array if none."),
  needsAttention: z
    .object({
      summary: z.string(),
      reason: z.string(),
      dueDate: z.string().nullable().describe("ISO date YYYY-MM-DD if a deadline is stated or clearly implied, else null"),
    })
    .nullable()
    .describe("Set only if there's a non-event action item — a form, payment, or reply needed. Null if purely informational or purely an event announcement."),
});
export type EvieAction = z.infer<typeof EvieActionSchema>;

const CLASSIFY_SYSTEM_PROMPT = `You triage school emails for a parent (Chris) whose daughter Evie Payne-Hewitt is in Year 3, class "Australia", taught by Mrs/Miss Pearson. Evie is also in Choir Club and Cooking Club.

This email matched a keyword search but may be a false positive (e.g. an unrelated email that happens to mention "Australia" or a common surname). Read it carefully and decide if it's genuinely about Evie, her class, her teacher, or her clubs.

If relevant, extract any dated events (school trips, sports day, concerts, INSET/non-pupil days, club sessions) and any non-event action item (permission slips, payment requests, forms, replies needed) with its deadline if one is stated.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"relevant": boolean, "events": [{"title": string, "date": "YYYY-MM-DD", "startTime": "HH:MM"|null, "endTime": "HH:MM"|null, "location": string|null}], "needsAttention": {"summary": string, "reason": string, "dueDate": "YYYY-MM-DD"|null} | null}`;

function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

export async function classifyEvieEmail(
  dbEnv: Env,
  env: LlmEnv,
  email: { sender: string; subject: string; date: string; body: string }
): Promise<EvieAction> {
  const userText = `From: ${email.sender}\nSubject: ${email.subject}\nDate: ${email.date}\n\nBody:\n${email.body}`;
  const result = await routedComplete(env, `${email.subject} ${email.body}`, CLASSIFY_SYSTEM_PROMPT, userText, 500, "claude-haiku-4-5");
  await logModelCall(dbEnv, {
    provider: result.model,
    feature: "evie_scan_classify",
    model: result.modelId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  return EvieActionSchema.parse(parseJsonLoose(result.text));
}
