import type { Env } from "../db.js";
import type { LlmEnv } from "../llm/env.js";
import { phraseNudge } from "../llm/nudgeMessage.js";
import type { NotionRepo } from "../notion/queries.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";
import { getSnoozedTaskIds, recordPush, shouldPush } from "./nudgeStore.js";

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
 * is enough to make its nudge stop appearing on the next check. Snoozed
 * tasks (nudgeStore.ts's snoozed_nudges, not Notion data) are filtered out
 * before either the in-app list or the ntfy push happens, so snoozing
 * suppresses both — once the snooze elapses the task is re-evaluated
 * normally, including "was it marked Done in the meantime." */
export async function runNudgeCheck(dbEnv: Env, llmEnv: LlmEnv, ntfyEnv: NtfyEnv, repo: NotionRepo): Promise<NudgeItem[]> {
  const [overdueRaw, snoozed] = await Promise.all([repo.listOverdueTasks(), getSnoozedTaskIds(dbEnv)]);
  const overdue = overdueRaw.filter((task) => !snoozed.has(task.id));
  const today = todayIso();

  return Promise.all(
    overdue.map(async (task): Promise<NudgeItem> => {
      const message = await phraseNudge(llmEnv, task);
      let pushed = false;

      if (ntfyEnv.topic && (await shouldPush(dbEnv, task.id, today))) {
        try {
          await notify(ntfyEnv.topic, message);
          await recordPush(dbEnv, task.id, today);
          pushed = true;
        } catch (error) {
          console.error(`[nudges] push failed for task ${task.id}:`, error);
        }
      }

      return { taskId: task.id, title: task.title, due: task.due, projectName: task.projectName, message, pushed };
    })
  );
}
