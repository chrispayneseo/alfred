// Gmail API operations — read-only + draft creation only.
//
// SAFETY INVARIANT: this file must never call an endpoint that sends mail
// (gmail.users.messages.send, gmail.users.drafts.send, or the "send" field on
// any batch operation). Alfred creates drafts for the user to review, edit,
// and send themselves from Gmail — nothing here transmits anything. This is
// enforced by code review, not by the OAuth scope (gmail.compose technically
// permits sending; see server/google/oauth.ts for why that scope is still
// the right choice). Step 5's verification pass greps this constraint.
import { gmail_v1 } from "googleapis";
import { createAuthenticatedClient } from "./client";
import type { GoogleEnv } from "./env";
import { GoogleNotConnectedError, GoogleReconnectRequiredError, isGoogleAuthError } from "./errors";

/** Deep link back to the thread in the Gmail web UI, stored on Notion pages
 * filed from email so the user can jump straight to the original message. */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface EmailMetadata {
  id: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string; // ISO
  snippet: string;
  labelIds: string[];
}

export interface ReplyHeaders {
  toEmail: string;
  subject: string;
  messageIdHeader?: string;
  references?: string;
}

function getClient(env: GoogleEnv): gmail_v1.Gmail {
  if (!env.refreshToken) throw new GoogleNotConnectedError();
  return new gmail_v1.Gmail({ auth: createAuthenticatedClient(env) });
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function parseSender(fromHeader: string | undefined): { sender: string; senderEmail: string } {
  if (!fromHeader) return { sender: "(unknown)", senderEmail: "" };
  const match = fromHeader.match(/^(.*?)\s*<(.+)>$/);
  if (match) return { sender: match[1].replace(/"/g, "").trim() || match[2], senderEmail: match[2].trim() };
  return { sender: fromHeader, senderEmail: fromHeader };
}

async function withAuthErrorMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isGoogleAuthError(error)) throw new GoogleReconnectRequiredError(error);
    throw error;
  }
}

/** Lists message refs in the inbox after a given date (paginated). */
export async function listInboxMessageIds(
  env: GoogleEnv,
  options: { afterDate: Date; pageToken?: string; pageSize?: number }
): Promise<{ refs: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }> {
  const gmail = getClient(env);
  const afterQuery = `after:${Math.floor(options.afterDate.getTime() / 1000)}`;

  return withAuthErrorMapping(async () => {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      q: afterQuery,
      maxResults: options.pageSize ?? 50,
      pageToken: options.pageToken,
    });
    const refs = (res.data.messages ?? [])
      .filter((m): m is { id: string; threadId: string } => Boolean(m.id && m.threadId))
      .map((m) => ({ id: m.id, threadId: m.threadId }));
    return {
      refs,
      nextPageToken: res.data.nextPageToken ?? undefined,
      resultSizeEstimate: res.data.resultSizeEstimate ?? undefined,
    };
  });
}

/** Cheap metadata-only fetch — no body. */
export async function getMessageMetadata(env: GoogleEnv, id: string): Promise<EmailMetadata> {
  const gmail = getClient(env);
  return withAuthErrorMapping(async () => {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = res.data.payload?.headers;
    const { sender, senderEmail } = parseSender(header(headers, "From"));
    const dateHeader = header(headers, "Date");

    return {
      id: res.data.id ?? id,
      threadId: res.data.threadId ?? id,
      sender,
      senderEmail,
      subject: header(headers, "Subject") || "(no subject)",
      date: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
      snippet: res.data.snippet ?? "",
      labelIds: res.data.labelIds ?? [],
    };
  });
}

/** Headers needed to compose a threaded reply — fetched on demand at draft time. */
export async function getReplyHeaders(env: GoogleEnv, id: string): Promise<ReplyHeaders> {
  const gmail = getClient(env);
  return withAuthErrorMapping(async () => {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-Id", "References"],
    });
    const headers = res.data.payload?.headers;
    const { senderEmail } = parseSender(header(headers, "From"));
    const subject = header(headers, "Subject") || "";
    const messageIdHeader = header(headers, "Message-Id");
    const priorReferences = header(headers, "References");

    return {
      toEmail: senderEmail,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      messageIdHeader,
      references: [priorReferences, messageIdHeader].filter(Boolean).join(" "),
    };
  });
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function extractPlainText(part: gmail_v1.Schema$MessagePart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child);
    if (found) return found;
  }
  // Fall back to HTML, stripped, only if no plain-text part exists anywhere.
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child);
    if (found) return found;
  }
  return undefined;
}

/** Fetches the full body on demand — never stored, only used transiently
 * (action-item scanning, Q&A grounding). */
export async function getMessageBody(env: GoogleEnv, id: string): Promise<string> {
  const gmail = getClient(env);
  return withAuthErrorMapping(async () => {
    const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    return extractPlainText(res.data.payload) ?? res.data.snippet ?? "";
  });
}

/** Live Gmail search (not the local metadata cache) — for Q&A grounding. */
export async function searchMessages(env: GoogleEnv, query: string, maxResults: number): Promise<EmailMetadata[]> {
  const gmail = getClient(env);
  return withAuthErrorMapping(async () => {
    const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
    const refs = res.data.messages ?? [];
    const metas = await Promise.all(refs.map((r) => (r.id ? getMessageMetadata(env, r.id) : undefined)));
    return metas.filter((m): m is EmailMetadata => m !== undefined);
  });
}

function buildRawMimeMessage(headers: ReplyHeaders, bodyText: string): string {
  const lines = [
    `To: ${headers.toEmail}`,
    `Subject: ${headers.subject}`,
    ...(headers.messageIdHeader ? [`In-Reply-To: ${headers.messageIdHeader}`] : []),
    ...(headers.references ? [`References: ${headers.references}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    bodyText,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/**
 * Creates a Gmail draft reply in the original thread. DRAFT ONLY — this calls
 * users.drafts.create and nothing else; the user sends it themselves from Gmail.
 */
export async function createDraftReply(
  env: GoogleEnv,
  args: { threadId: string; replyHeaders: ReplyHeaders; bodyText: string }
): Promise<string> {
  const gmail = getClient(env);
  const raw = buildRawMimeMessage(args.replyHeaders, args.bodyText);

  return withAuthErrorMapping(async () => {
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw, threadId: args.threadId },
      },
    });
    if (!res.data.id) throw new Error("Gmail didn't return a draft id");
    return res.data.id;
  });
}
