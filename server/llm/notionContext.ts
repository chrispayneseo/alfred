import type { NotionRepo } from "../notion/queries.js";
import { deriveSearchQuery } from "./queryTerms.js";

const NOTION_KEYWORDS = ["task", "tasks", "note", "notes", "project", "notion", "todo", "to-do", "reminder"];

export function needsNotionContext(text: string): boolean {
  const lower = text.toLowerCase();
  return NOTION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** Searches Tasks/Notes and formats matches for the model's system context.
 * Never throws — a search problem becomes an honest note in the context. */
export async function buildNotionContext(repo: NotionRepo, text: string): Promise<string> {
  try {
    const { tasks, notes } = await repo.searchTasksAndNotes(deriveSearchQuery(text));
    if (tasks.length === 0 && notes.length === 0) {
      return "No matching Tasks or Notes were found in Notion for this question.";
    }

    const taskLines = tasks.map(
      (t) => `- [Task${t.done ? ", done" : ""}] ${t.title}${t.projectName ? ` (${t.projectName})` : ""}${t.due ? ` — due ${t.due}` : ""}`
    );
    const noteLines = notes.map((n) => `- [Note] ${n.title}${n.projectName ? ` (${n.projectName})` : ""}`);

    return `Here are matching items from the user's Notion workspace. Use them to answer precisely — do not guess.\n\n${[...taskLines, ...noteLines].join("\n")}`;
  } catch (error) {
    console.error("[notionContext] search failed:", error);
    return "Notion search couldn't be completed right now due to an error. Say so rather than guessing.";
  }
}
