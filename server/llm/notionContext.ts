import type { NotionRepo } from "../notion/queries.js";
import { deriveSearchQuery } from "./queryTerms.js";

const NOTION_KEYWORDS = ["task", "tasks", "note", "notes", "project", "notion", "todo", "to-do", "reminder"];

// Bounds how much of a single Note's body gets pulled into the context —
// most captured notes are short, but a note filed by the folder-scan script
// can be a whole extracted document; without a cap, one matching note could
// dominate the entire context window.
const MAX_NOTE_BODY_CHARS = 3000;

export function needsNotionContext(text: string): boolean {
  const lower = text.toLowerCase();
  return NOTION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** Searches Tasks/Notes and formats matches for the model's system context —
 * Notes include their body text (not just the title), bounded per note, so
 * Chat can actually answer from what a note says rather than just confirm it
 * exists. Never throws — a search problem becomes an honest note in the
 * context. */
export async function buildNotionContext(repo: NotionRepo, text: string): Promise<string> {
  try {
    const { tasks, notes } = await repo.searchTasksAndNotes(deriveSearchQuery(text));
    if (tasks.length === 0 && notes.length === 0) {
      return "No matching Tasks or Notes were found in Notion for this question.";
    }

    const taskLines = tasks.map(
      (t) => `- [Task${t.done ? ", done" : ""}] ${t.title}${t.projectName ? ` (${t.projectName})` : ""}${t.due ? ` — due ${t.due}` : ""}`
    );

    const noteBlocks = await Promise.all(
      notes.map(async (n) => {
        const header = `[Note] ${n.title}${n.projectName ? ` (${n.projectName})` : ""}`;
        try {
          const body = await repo.getNoteBody(n.id);
          if (!body) return `- ${header}`;
          const truncated = body.length > MAX_NOTE_BODY_CHARS;
          const excerpt = truncated ? `${body.slice(0, MAX_NOTE_BODY_CHARS)}…` : body;
          return `- ${header}\n${excerpt}${truncated ? "\n  [note content truncated]" : ""}`;
        } catch (error) {
          console.error(`[notionContext] couldn't fetch body for note ${n.id}:`, error);
          return `- ${header}`;
        }
      })
    );

    return `Here are matching items from the user's Notion workspace, including note content where available. Use them to answer precisely — do not guess beyond what's shown.\n\n${[...taskLines, ...noteBlocks].join("\n\n")}`;
  } catch (error) {
    console.error("[notionContext] search failed:", error);
    return "Notion search couldn't be completed right now due to an error. Say so rather than guessing.";
  }
}
