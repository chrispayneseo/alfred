// Evie — the school email monitor, folded into Alfred. Narrow by design: only
// cpayneer@gmail.com's synced inbox cache, only messages from a "halterworth"
// sender matching one of a fixed keyword list (see filters.ts), never a
// general inbox scan. Calendar events go through the same propose-then-
// confirm flow as Chat's event proposals (evie_event_proposals table +
// /api/evie/proposals routes) rather than auto-creating — non-event action
// items just get a push + a Today-screen row, no confirmation needed since
// nothing is written anywhere for those.
import type { Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { getMessageBody } from "../google/gmail.js";
import type { LlmEnv } from "../llm/env.js";
import { classifyEvieEmail } from "../llm/evieScan.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";
import { getEvieCandidates, insertActionItem, insertEventProposal, markEvieScanned } from "./store.js";

const CANDIDATE_LIMIT = 20;

export interface EvieCheckResult {
  candidates: number;
  eventsProposed: number;
  actionItemsFlagged: number;
}

export async function runEvieCheck(dbEnv: Env, llmEnv: LlmEnv, ntfyEnv: NtfyEnv, account: GoogleAccountEnv): Promise<EvieCheckResult> {
  const candidates = await getEvieCandidates(dbEnv, account.email, CANDIDATE_LIMIT);

  let eventsProposed = 0;
  let actionItemsFlagged = 0;

  for (const candidate of candidates) {
    try {
      // Full body, not just the cached snippet — a short preview isn't
      // enough to reliably judge relevance or extract a date/deadline
      // buried mid-email. Fetched on demand for the small, already-narrow
      // candidate set, same "fetch on demand" pattern emailScan.ts uses for
      // reply drafting.
      const body = await getMessageBody(account, candidate.id);
      const action = await classifyEvieEmail(dbEnv, llmEnv, {
        sender: candidate.sender,
        subject: candidate.subject,
        date: candidate.date,
        body,
      });

      if (action.relevant) {
        for (const event of action.events) {
          await insertEventProposal(dbEnv, {
            gmailRowKey: candidate.rowKey,
            accountEmail: candidate.accountEmail,
            threadId: candidate.threadId,
            title: event.title,
            date: event.date,
            startTime: event.startTime ?? undefined,
            endTime: event.endTime ?? undefined,
            location: event.location ?? undefined,
          });
          eventsProposed++;
        }

        if (action.needsAttention) {
          await insertActionItem(dbEnv, {
            gmailRowKey: candidate.rowKey,
            accountEmail: candidate.accountEmail,
            threadId: candidate.threadId,
            subject: candidate.subject,
            summary: action.needsAttention.summary,
            reason: action.needsAttention.reason,
            dueDate: action.needsAttention.dueDate ?? undefined,
          });
          actionItemsFlagged++;

          // One-shot: each email is only ever classified once (see
          // markEvieScanned below), so there's no risk of re-pushing the
          // same item on a later check — no throttle table needed, unlike
          // nudges (which re-derives from live Notion state every call).
          if (ntfyEnv.topic) {
            try {
              await notify(ntfyEnv.topic, action.needsAttention.summary, candidate.subject);
            } catch (error) {
              console.error("[evie] push failed:", error);
            }
          }
        }
      }

      await markEvieScanned(dbEnv, candidate.rowKey);
    } catch (error) {
      console.error(`[evie] failed to check ${candidate.rowKey}:`, error);
      // Deliberately not marked scanned on failure — retried on the next
      // check instead of silently dropped.
    }
  }

  return { candidates: candidates.length, eventsProposed, actionItemsFlagged };
}
