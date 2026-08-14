import { classify as ruleBasedClassify } from "../notion/classify.js";
import { CLASSIFY_PROJECT_NAMES, DIGEST_PROJECTS, UNSORTED_PROJECT } from "../notion/schema.js";
import type { LlmEnv } from "./env.js";
import { routedComplete } from "./routedComplete.js";

export interface CaptureItem {
  text: string;
  type: "task" | "note";
  project: string;
}

const SPLIT_SYSTEM_PROMPT = `You process a free-form capture from a personal assistant's "jot it down" screen. The person may have typed or spoken several unrelated things at once (a brain dump), or just one thing — you need to tell the difference and classify each item.

For each genuinely distinct, unrelated item, output an object with:
- "text": the item's own text, close to the original wording, with connecting words like "also" or "and then" removed but nothing else changed or paraphrased
- "type": "task" if it's an action the person needs to do, "note" if it's information, an idea, or something to remember
- "project": whichever of ${DIGEST_PROJECTS.join(", ")} it most likely belongs to — if none clearly fits, use "${UNSORTED_PROJECT}"

Only split into multiple items when they are genuinely separate and unrelated things — a single sentence with normal clause structure, or one task with incidental detail, is NOT multiple items and must stay as one. When in doubt, don't split.

Respond with ONLY a JSON array of these objects, one per item, in the order they appeared. A single-item capture returns an array with exactly one object.`;

/** Exported for reuse by the /api/capture/multi route, which must validate
 * user-edited items the same strictly-typed way before writing to Notion. */
export function isCaptureItem(value: unknown): value is CaptureItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.text === "string" &&
    v.text.trim().length > 0 &&
    (v.type === "task" || v.type === "note") &&
    typeof v.project === "string" &&
    (CLASSIFY_PROJECT_NAMES as readonly string[]).includes(v.project)
  );
}

/** Single item, from the rule-based heuristic — used when the model call
 * itself fails outright (both providers down), same fallback philosophy the
 * old classifyWithModel had. A parse failure on a successful model response
 * is handled separately below (still worth trusting the model's raw text
 * over discarding it, since the call itself worked). */
function fallbackSingleItem(text: string): CaptureItem[] {
  return [{ text, ...ruleBasedClassify(text) }];
}

/** Detects whether a capture contains multiple distinct items and classifies
 * each — one model call handles both, via the routed model (Claude/ChatGPT
 * fallback), so a multi-item brain dump costs the same one round-trip as a
 * single item, not N+1. Always returns at least one item; length 1 means
 * "file directly as before," length > 1 means "show for review first." */
export async function splitAndClassifyCapture(env: LlmEnv, text: string): Promise<CaptureItem[]> {
  let raw: string;
  try {
    raw = await routedComplete(env, text, SPLIT_SYSTEM_PROMPT, text, 700, "claude-haiku-4-5");
  } catch (error) {
    console.error("[splitCapture] model call failed, falling back to rule-based single-item classification:", error);
    return fallbackSingleItem(text);
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    const items = Array.isArray(parsed) ? parsed.filter(isCaptureItem) : [];
    if (items.length === 0) throw new Error("no valid items in model output");
    return items;
  } catch (error) {
    console.error("[splitCapture] couldn't parse model output, falling back to rule-based single-item classification:", error, raw);
    return fallbackSingleItem(text);
  }
}
