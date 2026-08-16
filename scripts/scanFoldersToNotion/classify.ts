// Classifies one extracted document into work-exclude / personal-include /
// unclear, mirroring server/llm/searchConsoleQuery.ts's shape (a silent
// zod-validated extraction call, not a user-facing proposal). Deliberately
// standalone from server/llm/splitCapture.ts — that prompt is tuned for
// short multi-item "brain dump" captures, not whole documents, and this
// script skips the Postgres-backed cost logging entirely (it's a one-off
// local run, not part of the deployed app's request path).
import { z } from "zod";
import type { LlmEnv } from "../../server/llm/env.js";
import { routedComplete } from "../../server/llm/routedComplete.js";
import { FREELANCE_CLIENTS } from "../../server/notion/schema.js";
import type { Candidate } from "./discover.js";

const PERSONAL_PROJECTS = ["Freelance", "Personal", "Side Projects", "Football Coaching"] as const;

const ClassificationSchema = z.object({
  verdict: z.enum(["work_exclude", "personal_include", "unclear"]),
  project: z.enum(PERSONAL_PROJECTS).nullable(),
  client: z.string().nullable(),
  isNewClient: z.boolean(),
  genealogyRelated: z.boolean(),
  suggestedTitle: z.string(),
  reason: z.string(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

const MAX_SNIPPET_CHARS = 4000;

function buildSystemPrompt(): string {
  return `You are triaging personal files found on a broad scan of someone's Documents/Desktop folders, deciding what belongs in their personal Notion workspace.

EXCLUDE (verdict "work_exclude") anything related to their employer, Future PLC — job responsibilities, internal work documents, employer correspondence, work project files. Be confident before excluding — don't exclude something just because it sounds professional.

INCLUDE (verdict "personal_include") anything that is:
- Freelance work for their own business, Peacock Search, and its clients. Known clients so far: ${FREELANCE_CLIENTS.join(", ")}. If the document clearly names a different client not in that list, still classify it — just set "isNewClient" to true and put the client's actual name in "client".
- Personal — anything not tied to freelance/side-projects/football/genealogy specifically.
- Side projects — e.g. CoachPlan (a football-coaching app they built), home lab / self-hosted infrastructure, other personal software projects.
- Football coaching — coaching plans, session content, team admin for a football team they coach.
- Genealogy / family history research — set "project" to "Personal" AND "genealogyRelated" to true for these (genealogy doesn't have its own Notion project, it's filed under Personal with a distinguishing prefix).

If you cannot confidently tell whether something is work-related, OR you can tell it's personal but can't tell which of the four projects above it belongs to, set verdict to "unclear" and explain briefly in "reason" — do not guess when genuinely unsure, a human will review anything marked "unclear".

For "personal_include", set "project" to exactly one of: ${PERSONAL_PROJECTS.join(", ")}. For "work_exclude" or "unclear", set "project" to null.
Set "client" only when the project is "Freelance" and a specific client is identifiable from the content; otherwise null.
Set "suggestedTitle" to a short (under 80 characters) human-readable title for this document — from its actual title/heading if it has one, otherwise a plain description of what it is. Do not just repeat the filename verbatim if the content suggests a better title.
Set "reason" to one short sentence explaining the verdict — shown to the user during review, so make it genuinely useful for a quick decision.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"verdict": "work_exclude"|"personal_include"|"unclear", "project": ${PERSONAL_PROJECTS.map((p) => `"${p}"`).join("|")}|null, "client": string|null, "isNewClient": boolean, "genealogyRelated": boolean, "suggestedTitle": string, "reason": string}`;
}

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/** Returns undefined on any failure (model error, malformed JSON) — the
 * caller treats that the same as "unclear" and flags it for review rather
 * than silently dropping or including it. */
export async function classifyDocument(llmEnv: LlmEnv, candidate: Candidate, text: string, totalChars: number): Promise<Classification | undefined> {
  const snippet = text.slice(0, MAX_SNIPPET_CHARS);
  const truncatedNote = totalChars > snippet.length ? `\n\n[Snippet truncated — showing the first ${snippet.length} of ${totalChars} characters.]` : "";
  const userText = `File: ${candidate.relPath}\n\n${snippet}${truncatedNote}`;

  try {
    const result = await routedComplete(llmEnv, userText, buildSystemPrompt(), userText, 500, "claude-haiku-4-5");
    return ClassificationSchema.parse(parseJsonLoose(result.text));
  } catch (error) {
    console.error(`[classify] failed for ${candidate.relPath}:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}
