import { z } from "zod";
import { markAccountNeedsReconnect, markAccountOk, type GoogleAccountEnv } from "../google/accounts.js";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "../google/errors.js";
import { createDraftReply, getMessageBody, getReplyHeaders, gmailThreadUrl } from "../google/gmail.js";
import { getUnscannedEmails, markScanned, type EmailRecord } from "../google/gmailStore.js";
import type { NotionRepo } from "../notion/queries.js";
import { PROJECT_SEED_NAMES } from "../notion/schema.js";
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "./env.js";
import { routedComplete } from "./routedComplete.js";

const AUTOMATED_SENDER_PATTERN = /(no-?reply|do-?not-?reply|notifications?|mailer-daemon|newsletter|marketing)@/i;

/** Cheap pre-filter so obvious bulk/automated mail never costs an LLM call. */
export function looksAutomated(email: { senderEmail: string }): boolean {
  return AUTOMATED_SENDER_PATTERN.test(email.senderEmail);
}

const EmailActionSchema = z.object({
  actionable: z.boolean(),
  needsReply: z.boolean(),
  hasDeadline: z.boolean(),
  deadlineDate: z.string().nullable(),
  itemType: z.enum(["task", "note", "none"]),
  project: z.enum(PROJECT_SEED_NAMES),
  summary: z.string(),
});
export type EmailAction = z.infer<typeof EmailActionSchema>;

// Deliberately no mention of which account an email arrived on — a
// work-relevant email should file under Job even if it happened to land in
// the personal inbox, and vice versa (Step 8). The classifier only ever sees
// sender/subject/snippet, so account origin was never part of its signal.
const CLASSIFY_SYSTEM_PROMPT = `You triage inbox email for a personal assistant app. Given an email's sender, subject, and preview snippet, decide:
- actionable: does this email need the person's attention (a reply, a decision, tracking a deadline) — as opposed to something to skim or ignore (newsletters, receipts, automated notices)?
- needsReply: does this specifically expect a reply from the person?
- hasDeadline: does it mention a date/deadline the person should track?
- deadlineDate: that date in YYYY-MM-DD if known, else null.
- itemType: "task" if actionable and something to DO, "note" if actionable but just informational to keep, "none" if not actionable.
- project: which of Job, Freelance, Personal, or Football Coaching it most likely relates to. If none clearly fits, use "Unsorted".
- summary: a short one-line summary (under 12 words) suitable as a task/note title.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"actionable": boolean, "needsReply": boolean, "hasDeadline": boolean, "deadlineDate": string|null, "itemType": "task"|"note"|"none", "project": "Job"|"Freelance"|"Personal"|"Football Coaching"|"Unsorted", "summary": string}`;

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

export async function classifyEmailAction(
  dbEnv: Env,
  env: LlmEnv,
  email: { sender: string; subject: string; snippet: string }
): Promise<EmailAction> {
  const userText = `Sender: ${email.sender}\nSubject: ${email.subject}\nSnippet: ${email.snippet}`;
  // Cheap yes/no-shaped classification — same reasoning as the Notion capture
  // classifier (classify.ts) using Haiku instead of Chat's full-price Opus.
  const result = await routedComplete(env, `${email.subject} ${email.snippet}`, CLASSIFY_SYSTEM_PROMPT, userText, 300, "claude-haiku-4-5");
  await logModelCall(dbEnv, {
    provider: result.model,
    feature: "gmail_scan_classify",
    model: result.modelId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  return EmailActionSchema.parse(parseJsonLoose(result.text));
}

const DRAFT_SYSTEM_PROMPT = `You draft a suggested reply to an email on behalf of a person, for them to review and edit before sending — you never send anything yourself. Write a concise, natural, appropriately-toned plain-text reply based only on what's in the email. Do not invent facts, commitments, dates, or details not present in the original message. If a specific detail is needed that you don't have (e.g. exact availability), leave a clear placeholder like [confirm date] rather than guessing. No subject line, no signature — just the reply body.`;

export async function generateReplyDraft(dbEnv: Env, env: LlmEnv, email: { sender: string; subject: string }, fullBody: string): Promise<string> {
  const userText = `Original email from ${email.sender}, subject "${email.subject}":\n\n${fullBody.slice(0, 4000)}`;
  const result = await routedComplete(env, `${email.subject} ${fullBody}`, DRAFT_SYSTEM_PROMPT, userText, 500);
  await logModelCall(dbEnv, {
    provider: result.model,
    feature: "gmail_scan_reply",
    model: result.modelId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  return result.text;
}

export interface ScanStatus {
  running: boolean;
  processed: number;
  total: number;
  error?: string;
}

interface ScanJobRow {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
  updated_at: string;
}

const STALE_AFTER_MS = 6 * 60 * 1000;

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function toStatus(row: ScanJobRow): ScanStatus {
  return { running: row.running, processed: row.processed, total: row.total, error: row.error ?? undefined };
}

export async function getScanStatus(env: Env): Promise<ScanStatus> {
  const sql = await db(env);
  const [row] = (await sql.query("SELECT * FROM scan_job WHERE id = 'singleton'")) as ScanJobRow[];
  if (row.running && Date.now() - new Date(row.updated_at).getTime() > STALE_AFTER_MS) {
    const [updated] = (await sql.query(
      "UPDATE scan_job SET running = false, error = 'timeout', updated_at = now() WHERE id = 'singleton' RETURNING *"
    )) as ScanJobRow[];
    return toStatus(updated);
  }
  return toStatus(row);
}

/** Scans up to `limit` unscanned emails, regardless of which connected
 * account they came from: classifies each with the routed model (Step 3's
 * routing/fallback), files actionable ones into Notion, and creates a Gmail
 * draft (never sends) for anything needing a reply — using the SAME account
 * the email arrived on. Claimed atomically against scan_job, same pattern as
 * gmailSync.ts's startSync. `backgroundTask` lets the work continue after
 * this returns (fire-and-forget locally, Vercel's waitUntil in production).
 * Call getScanStatus() to poll progress. */
export async function startScan(
  env: Env,
  llmEnv: LlmEnv,
  accounts: GoogleAccountEnv[],
  notionRepo: NotionRepo,
  limit: number,
  backgroundTask: (task: Promise<unknown>) => void
): Promise<ScanStatus> {
  const batch = await getUnscannedEmails(env, limit);
  const sql = await db(env);
  const claimed = (await sql.query(
    `UPDATE scan_job SET running = true, processed = 0, total = $1, error = NULL, updated_at = now()
     WHERE id = 'singleton' AND running = false
     RETURNING *`,
    [batch.length]
  )) as ScanJobRow[];
  if (claimed.length === 0) return getScanStatus(env);

  backgroundTask(runScan(env, llmEnv, accounts, notionRepo, batch));

  return toStatus(claimed[0]);
}

async function runScan(
  env: Env,
  llmEnv: LlmEnv,
  accounts: GoogleAccountEnv[],
  notionRepo: NotionRepo,
  batch: EmailRecord[]
): Promise<void> {
  const sql = await db(env);
  const accountByEmail = new Map(accounts.map((a) => [a.email, a]));
  // If an account's token turns out to need reconnecting mid-batch, don't
  // keep retrying Gmail calls against it for every remaining email from that
  // account — just skip them (still marked scanned, as "nothing found",
  // same as any other per-email failure) and keep processing the other
  // account's emails normally (Step 8: one stale token shouldn't stall both).
  const brokenAccounts = new Set<string>();

  for (const email of batch) {
    const account = accountByEmail.get(email.accountEmail);
    try {
      if (!account || brokenAccounts.has(email.accountEmail)) {
        await markScanned(env, email.accountEmail, email.id, { actionable: false, needsReply: false, hasDeadline: false });
      } else {
        await scanOne(env, llmEnv, account, notionRepo, email);
        await markAccountOk(env, account.email);
      }
    } catch (error) {
      if (error instanceof GoogleNotConnectedError || error instanceof GoogleReconnectRequiredError) {
        console.error(`[emailScan] account ${email.accountEmail} needs reconnecting — skipping its remaining emails this batch`);
        await markAccountNeedsReconnect(env, email.accountEmail);
        brokenAccounts.add(email.accountEmail);
      } else {
        console.error(`[emailScan] failed to scan ${email.id}:`, error);
      }
      await markScanned(env, email.accountEmail, email.id, { actionable: false, needsReply: false, hasDeadline: false });
    }
    await sql.query("UPDATE scan_job SET processed = processed + 1, updated_at = now() WHERE id = 'singleton'");
  }

  // Only surface a job-level error if every account hit in this batch was
  // broken — a partial failure just quietly processes fewer emails, visible
  // per-account in Settings rather than blocking the whole scan.
  const accountsInBatch = new Set(batch.map((e) => e.accountEmail));
  const allFailed = accountsInBatch.size > 0 && [...accountsInBatch].every((email) => brokenAccounts.has(email));
  await sql.query("UPDATE scan_job SET running = false, error = $1, updated_at = now() WHERE id = 'singleton'", [
    allFailed ? "reconnect_required" : null,
  ]);
}

async function scanOne(env: Env, llmEnv: LlmEnv, account: GoogleAccountEnv, notionRepo: NotionRepo, email: EmailRecord): Promise<void> {
  if (looksAutomated(email)) {
    await markScanned(env, email.accountEmail, email.id, { actionable: false, needsReply: false, hasDeadline: false });
    return;
  }

  const action = await classifyEmailAction(env, llmEnv, email);
  let notionPageId: string | undefined;
  let draftId: string | undefined;
  const emailLink = gmailThreadUrl(email.threadId, email.accountEmail);

  if (action.actionable && action.itemType !== "none") {
    const itemType: "task" | "note" = action.itemType;
    const title = action.summary || email.subject;
    const inbox = await notionRepo.createInboxPage(title, "email", emailLink);
    const filed = await notionRepo.fileClassifiedItem(inbox.id, title, { type: itemType, project: action.project }, emailLink);
    notionPageId = filed.id;
  }

  if (action.needsReply) {
    const [fullBody, replyHeaders] = await Promise.all([
      getMessageBody(account, email.id),
      getReplyHeaders(account, email.id),
    ]);
    const draftText = await generateReplyDraft(env, llmEnv, email, fullBody);
    draftId = await createDraftReply(account, { threadId: email.threadId, replyHeaders, bodyText: draftText });
  }

  await markScanned(env, email.accountEmail, email.id, {
    actionable: action.actionable,
    needsReply: action.needsReply,
    hasDeadline: action.hasDeadline,
    deadlineDate: action.deadlineDate ?? undefined,
    project: action.actionable ? action.project : undefined,
    itemType: action.itemType !== "none" ? action.itemType : undefined,
    notionPageId,
    draftId,
  });
}
