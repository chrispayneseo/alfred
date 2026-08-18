// Scans Gmail for Leeds United ticket-window emails and extracts, per
// fixture, the individual sale/ballot phases (a single email — e.g. the
// Brentford home-ticket email — can list five phases: a direct-sale window
// for one tier, a ballot application for others, a second ballot, parking,
// and a tier-split ticket-exchange window). Distinct scan concern from
// emailScan.ts's action-item classifier and the news feed's newsletter
// scan, tracked via its own leeds_scanned_emails table (same pattern as
// evie_scanned_messages / news_feed_scanned_emails).
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { getMessageBody } from "../google/gmail.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import { MEMBERSHIP_TIERS, type MembershipTier } from "./settings.js";

const SENDER_PATTERN = "%service.leedsunited.com%";
const SUBJECT_PATTERN = "%ticket%";
const SCAN_LIMIT = 15;
const EXTRACT_MODEL = "claude-haiku-4-5";

interface CandidateRow {
  row_key: string;
  account_email: string;
  id: string;
  subject: string;
  date: string;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

/** Resolves a "YYYY-MM-DD" + "HH:MM" pair, understood as Europe/London wall-clock
 * time (the emails never state a timezone — they're always UK local), to the
 * correct UTC instant — tries both the BST (+1) and GMT (+0) offsets and keeps
 * whichever one round-trips back to the requested local time. Avoids needing a
 * DST calendar or a new dependency. */
function londonTimeToUtc(dateStr: string, timeStr: string): Date {
  for (const offsetHours of [1, 0]) {
    const guess = new Date(`${dateStr}T${timeStr}:00.000Z`);
    guess.setUTCHours(guess.getUTCHours() - offsetHours);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(guess).map((p) => [p.type, p.value])
    );
    const rendered = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    if (rendered === `${dateStr} ${timeStr}`) return guess;
  }
  return new Date(`${dateStr}T${timeStr}:00.000Z`);
}

const EXTRACT_SYSTEM_PROMPT = `You extract Leeds United ticket-sale-window information from a ticket-information email for a personal assistant app.

There are three My Leeds membership tiers, ranked lowest to highest: "base" (My Leeds Members / "My Leeds" / "All My Leeds Members"), "plus" (My Leeds+ / "My Leeds Plus"), "priority" (My Leeds Priority). When a phase names "All My Leeds Members" or doesn't distinguish tiers, ALL THREE tiers are eligible. When a phase is restricted to specific named tiers (e.g. "My Leeds Priority & My Leeds+ Members"), only those tiers are eligible — do not assume a higher tier implies eligibility unless the text says so or says "All".

A ticket email can describe several distinct phases (direct on-sale windows, ballot applications, ticket exchange windows, parking, etc.) — extract EVERY phase that is either a genuine ticket purchase opportunity or a ballot you'd need to apply to. Skip phases that are clearly not about match tickets themselves (e.g. car parking only, unless no other phases exist).

For each phase, classify its "kind":
- "direct_sale": a first-come-first-served purchase window, or a guaranteed-ticket priority window for confirmed ballot winners.
- "ballot_application": an application window with a chance of success — extract its open AND close time (the close time is the deadline to apply).

Respond with ONLY a JSON object (no markdown, no commentary), in exactly this shape:
{"opponent": "string", "homeAway": "H"|"A", "phases": [{"label": "short phase name, e.g. 'My Leeds Priority direct sale'", "kind": "direct_sale"|"ballot_application", "eligibleTiers": ["base"|"plus"|"priority", ...], "opensDate": "YYYY-MM-DD", "opensTime": "HH:MM" (24h), "closesDate": "YYYY-MM-DD"|null, "closesTime": "HH:MM"|null, "confidence": "clear"|"unclear"}]}

Use the email's own send date (given to you) to resolve any date that omits a year — always the nearest occurrence on or after the email's send date, never in the past. Set "confidence" to "unclear" for a phase if you cannot confidently determine either its eligible tiers or its date/time from the email text — still give your best-effort values, but mark it unclear so a human can double check. If the email describes no genuine ticket phases at all, respond with exactly: {"opponent": "", "homeAway": "H", "phases": []}`;

interface RawPhase {
  label: string;
  kind: string;
  eligibleTiers: string[];
  opensDate: string;
  opensTime: string;
  closesDate: string | null;
  closesTime: string | null;
  confidence: string;
}

interface RawExtraction {
  opponent: string;
  homeAway: string;
  phases: RawPhase[];
}

function isRawPhase(value: unknown): value is RawPhase {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.label === "string" &&
    (v.kind === "direct_sale" || v.kind === "ballot_application") &&
    Array.isArray(v.eligibleTiers) &&
    typeof v.opensDate === "string" &&
    typeof v.opensTime === "string" &&
    (v.closesDate === null || typeof v.closesDate === "string") &&
    (v.closesTime === null || typeof v.closesTime === "string") &&
    (v.confidence === "clear" || v.confidence === "unclear")
  );
}

function parseJsonObjectLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

async function extractFromBody(dbEnv: Env, llmEnv: LlmEnv, body: string, sentAt: string): Promise<RawExtraction | undefined> {
  const userText = `Email sent: ${sentAt}\n\nEmail body:\n${body.slice(0, 6000)}`;
  try {
    const result = await routedComplete(llmEnv, "leeds ticket window extraction", EXTRACT_SYSTEM_PROMPT, userText, 1200, EXTRACT_MODEL);
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "leeds_ticket_extraction",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = parseJsonObjectLoose(result.text) as Partial<RawExtraction>;
    if (typeof parsed.opponent !== "string" || (parsed.homeAway !== "H" && parsed.homeAway !== "A") || !Array.isArray(parsed.phases)) {
      return undefined;
    }
    return { opponent: parsed.opponent, homeAway: parsed.homeAway, phases: parsed.phases.filter(isRawPhase) };
  } catch (error) {
    console.error("[leedsTickets] extraction call failed:", error);
    return undefined;
  }
}

async function markScanned(env: Env, rowKeys: string[]): Promise<void> {
  if (rowKeys.length === 0) return;
  const sql = await db(env);
  for (const rowKey of rowKeys) {
    await sql.query("INSERT INTO leeds_scanned_emails (row_key) VALUES ($1) ON CONFLICT (row_key) DO NOTHING", [rowKey]);
  }
}

/** Scans a batch of not-yet-scanned Leeds ticket-information emails, extracts
 * every phase, and stores one row per phase the user is eligible for
 * (`eligible`) or genuinely can't confirm (`needs_review`) — a phase the
 * model confidently determined is NOT for the user's tier is simply dropped,
 * per "only track fixtures I'm actually eligible for." Never throws — a
 * failure here should never block the rest of a Today load. */
export async function scanLeedsTicketEmails(dbEnv: Env, llmEnv: LlmEnv, accounts: GoogleAccountEnv[], tier: MembershipTier): Promise<void> {
  try {
    const sql = await db(dbEnv);
    const rows = (await sql.query(
      `SELECT g.row_key, g.account_email, g.id, g.subject, g.date
       FROM gmail_emails g
       LEFT JOIN leeds_scanned_emails s ON s.row_key = g.row_key
       WHERE s.row_key IS NULL AND g.sender_email ILIKE $1 AND g.subject ILIKE $2
       ORDER BY g.date DESC
       LIMIT $3`,
      [SENDER_PATTERN, SUBJECT_PATTERN, SCAN_LIMIT]
    )) as CandidateRow[];

    if (rows.length === 0) return;

    const accountByEmail = new Map(accounts.map((a) => [a.email, a]));
    const scannedKeys: string[] = [];

    for (const row of rows) {
      scannedKeys.push(row.row_key);
      const account = accountByEmail.get(row.account_email);
      if (!account) continue;

      let body: string;
      try {
        body = await getMessageBody(account, row.id);
      } catch (error) {
        console.error(`[leedsTickets] failed to fetch body for ${row.row_key}:`, error);
        continue;
      }

      const extraction = await extractFromBody(dbEnv, llmEnv, body, row.date);
      if (!extraction || extraction.phases.length === 0) continue;

      for (const phase of extraction.phases) {
        const tiers = phase.eligibleTiers.filter((t): t is MembershipTier => (MEMBERSHIP_TIERS as readonly string[]).includes(t));
        const eligible = phase.confidence === "clear" && tiers.includes(tier);
        const needsReview = phase.confidence === "unclear";
        if (!eligible && !needsReview) continue; // confidently not for this tier — skip entirely

        let opensAt: Date;
        let closesAt: Date | null = null;
        try {
          opensAt = londonTimeToUtc(phase.opensDate, phase.opensTime);
          if (phase.closesDate && phase.closesTime) closesAt = londonTimeToUtc(phase.closesDate, phase.closesTime);
        } catch {
          continue; // unparseable date — nothing sensible to store
        }

        // Content-keyed, not source-email-keyed: the same club-wide ticket
        // email routinely lands in more than one of the user's connected
        // accounts, and a concurrent scan (e.g. React StrictMode's
        // double-effect-fire on Today) could also process the same email
        // twice — either way, the same real-world phase should only ever
        // produce one row.
        const existing = await sql.query(
          "SELECT 1 FROM leeds_ticket_windows WHERE opponent = $1 AND home_away = $2 AND phase_label = $3 LIMIT 1",
          [extraction.opponent, extraction.homeAway, phase.label]
        );
        if (existing.length > 0) continue;

        await sql.query(
          `INSERT INTO leeds_ticket_windows
             (id, gmail_row_key, opponent, home_away, phase_label, phase_kind, window_opens_at, window_closes_at, eligibility_status, eligibility_note, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
          [
            crypto.randomUUID(),
            row.row_key,
            extraction.opponent,
            extraction.homeAway,
            phase.label,
            phase.kind,
            opensAt.toISOString(),
            closesAt ? closesAt.toISOString() : null,
            needsReview ? "needs_review" : "eligible",
            needsReview ? "Couldn't confidently determine eligibility or timing from the email — check it yourself." : null,
          ]
        );
      }
    }

    await markScanned(dbEnv, scannedKeys);
  } catch (error) {
    console.error("[leedsTickets] scan failed:", error);
  }
}
