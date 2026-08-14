import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { classify as ruleBasedClassify, type Classification } from "../notion/classify";
import { PROJECT_SEED_NAMES, UNSORTED_PROJECT } from "../notion/schema";
import { getAnthropicClient } from "./anthropic";

const ClassificationSchema = z.object({
  type: z.enum(["task", "note"]),
  project: z.enum(PROJECT_SEED_NAMES),
});

const CLASSIFY_SYSTEM_PROMPT = `Classify a short personal capture for a task-and-notes app.

Decide:
- type: "task" if it's an action the person needs to do, "note" if it's information, an idea, or something to remember.
- project: which of Job, Freelance, Personal, or Football Coaching it most likely belongs to. If none clearly fits, use "${UNSORTED_PROJECT}".`;

/** Real model classification (Claude Haiku — cheap and fast for this short structured task),
 * falling back to the rule-based heuristic if the call fails for any reason. */
export async function classifyWithModel(apiKey: string, text: string): Promise<Classification> {
  try {
    const anthropic = getAnthropicClient(apiKey);
    const response = await anthropic.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
      output_config: { format: zodOutputFormat(ClassificationSchema) },
    });

    const parsed = response.parsed_output;
    if (!parsed) throw new Error("classification returned no parsed output");
    return parsed;
  } catch (error) {
    console.error("[classify] model classification failed, falling back to rule-based heuristic:", error);
    return ruleBasedClassify(text);
  }
}
