import type { LlmEnv } from "../llm/env";
import { phraseNudge } from "../llm/nudgeMessage";
import type { NotionRepo } from "../notion/queries";
import type { NtfyEnv } from "../notify/env";
import { notify } from "../notify/ntfy";
import { recordPush, shouldPush } from "./nudgeStore";

export interface NudgeItem {
  taskId: string;
  title: string;
  due?: string;
  projectName?: string;
  message: string;
  pushed: boolean;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Queries Notion for overdue open Tasks, phrases a gentle nudge for each
 * with the routed model, and pushes any not already pushed today to ntfy.
 * Written so a real scheduler can call this exact function later — for v1
 * it's triggered on Today-screen load. No "dismissed" state is tracked: the
 * task list is re-derived live every call, so marking a task Done in Notion
 * is enough to make its nudge stop appearing on the next check. */
export async function runNudgeCheck(llmEnv: LlmEnv, ntfyEnv: NtfyEnv, repo: NotionRepo): Promise<NudgeItem[]> {
  const overdue = await repo.listOverdueTasks();
  const today = todayIso();

  return Promise.all(
    overdue.map(async (task): Promise<NudgeItem> => {
      const message = await phraseNudge(llmEnv, task);
      let pushed = false;

      if (ntfyEnv.topic && shouldPush(task.id, today)) {
        try {
          await notify(ntfyEnv.topic, message);
          recordPush(task.id, today);
          pushed = true;
        } catch (error) {
          console.error(`[nudges] push failed for task ${task.id}:`, error);
        }
      }

      return { taskId: task.id, title: task.title, due: task.due, projectName: task.projectName, message, pushed };
    })
  );
}
