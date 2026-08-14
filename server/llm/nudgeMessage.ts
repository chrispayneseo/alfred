import type { TaskRecord } from "../notion/queries";
import type { LlmEnv } from "./env";
import { routedComplete } from "./routedComplete";

const NUDGE_SYSTEM_PROMPT = `You write a single short, gentle nudge reminding someone about an overdue task in their personal assistant app. Calm and warm, never alarmist or guilt-inducing — a soft reminder, not a scold. One sentence, under 25 words, no greeting, no sign-off, plain text only.`;

/** Phrases a nudge for one overdue task via the routed model (Step 3's
 * routing/fallback). Cheap, short, classification-adjacent task — same
 * reasoning as emailScan.ts's classification call for using Haiku over
 * Chat's full-price Opus on the Claude side. */
export function phraseNudge(env: LlmEnv, task: Pick<TaskRecord, "title" | "due" | "projectName">): Promise<string> {
  const userText = `Task: ${task.title}\nDue: ${task.due ?? "an earlier date"}${task.projectName ? `\nProject: ${task.projectName}` : ""}`;
  return routedComplete(env, task.title, NUDGE_SYSTEM_PROMPT, userText, 80, "claude-haiku-4-5");
}
