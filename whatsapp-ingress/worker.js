const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const privacyPage = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Alfred Inbox privacy information</title><style>body{max-width:42rem;margin:2rem auto;padding:0 1.25rem;color:#262522;background:#faf9f6;font:1rem/1.6 system-ui,sans-serif}h1{font-size:1.9rem;line-height:1.2}h2{margin-top:2rem;font-size:1.2rem}</style></head><body><main>
<h1>Alfred Inbox privacy information</h1><p>Last updated 24 September 2026</p>
<p>Alfred Inbox is a private, single-user tool. It is not offered to the public and does not provide customer messaging or a public AI assistant. Its operator uses a dedicated WhatsApp number to collect text that they choose to send or forward for personal review.</p>
<h2>What it receives</h2><p>The inbox accepts text messages only from the operator's own WhatsApp account. Forwarded text may contain information originally written by someone else. Messages from other senders, attachments and media are not saved by Alfred Inbox.</p>
<h2>How messages are handled</h2><p>WhatsApp/Meta delivers incoming messages to a secure Cloudflare webhook. A temporary copy is held in a Cloudflare database until the operator's Dell computer has stored it locally. The temporary copy is then deleted. Only the operator can access the local inbox over their private network.</p>
<p>Alfred Inbox does not automatically reply to WhatsApp messages, create tasks or reminders, or send forwarded text to a cloud AI model. Any future action or cloud escalation requires a separate, explicit choice by the operator.</p>
<h2>Retention and control</h2><p>Locally collected messages remain on the operator's Dell until the operator reviews or deletes them. If the collector is offline, a temporary message may remain in Cloudflare storage until collection resumes or the operator deletes it. The operator can stop collection by disabling the collector and webhook.</p>
<h2>Questions</h2><p>Only the operator can send to this inbox. If you have a question about information you sent to the operator that they later forwarded, please contact the operator through the same channel you normally use to communicate with them.</p>
</main></body></html>`;

function normalizedNumber(value) {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

async function validMetaSignature(rawBody, header, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(header ?? "")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const supplied = Uint8Array.from((header ?? "").slice(7).match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", key, supplied, rawBody);
}

function isCollector(request, env) {
  const expected = env.COLLECTOR_TOKEN;
  return Boolean(expected && expected.length >= 32 && request.headers.get("authorization") === `Bearer ${expected}`);
}

async function receiveWebhook(request, env) {
  if (!env.META_APP_SECRET || !env.ALLOWED_SENDER || !env.PHONE_NUMBER_ID || !env.INBOX_DB) {
    return json({ error: "not_configured" }, 503);
  }
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > 256_000) return json({ error: "too_large" }, 413);
  if (!(await validMetaSignature(rawBody, request.headers.get("x-hub-signature-256"), env.META_APP_SECRET))) {
    return json({ error: "invalid_signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (payload?.object !== "whatsapp_business_account") return json({ accepted: 0 });

  let accepted = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      if (String(value.metadata?.phone_number_id ?? "") !== env.PHONE_NUMBER_ID) continue;
      for (const message of value.messages ?? []) {
        // Never store Peacock customer messages, app echoes, statuses or media.
        if (normalizedNumber(message.from) !== normalizedNumber(env.ALLOWED_SENDER)) continue;
        if (message.type !== "text" || !message.text?.body || !message.id) continue;
        const body = String(message.text.body).slice(0, 10_000);
        await env.INBOX_DB.prepare(
          "INSERT OR IGNORE INTO whatsapp_inbox (id, body, sent_at) VALUES (?, ?, ?)",
        ).bind(String(message.id), body, String(message.timestamp ?? "")).run();
        accepted += 1;
      }
    }
  }
  return json({ accepted });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/privacy" && request.method === "GET") {
      return new Response(privacyPage, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-robots-tag": "noindex, nofollow" } });
    }
    if (url.pathname === "/webhook" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode !== "subscribe" || !env.META_VERIFY_TOKEN || token !== env.META_VERIFY_TOKEN || !challenge) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(challenge, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/webhook" && request.method === "POST") return receiveWebhook(request, env);
    if (url.pathname === "/inbox" && request.method === "GET") {
      if (!isCollector(request, env)) return json({ error: "unauthorized" }, 401);
      const rows = await env.INBOX_DB.prepare(
        "SELECT id, body, sent_at, received_at FROM whatsapp_inbox ORDER BY received_at LIMIT 20",
      ).all();
      return json({ messages: rows.results ?? [] });
    }
    if (url.pathname === "/inbox/ack" && request.method === "POST") {
      if (!isCollector(request, env)) return json({ error: "unauthorized" }, 401);
      let id;
      try {
        id = (await request.json()).id;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      // Meta message IDs can contain base64 padding. The prepared statement
      // keeps the value safe; this check only bounds the accepted input.
      if (typeof id !== "string" || !/^wamid\.[A-Za-z0-9_+/=.-]{8,256}$/.test(id)) return json({ error: "invalid_id" }, 400);
      await env.INBOX_DB.prepare("DELETE FROM whatsapp_inbox WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  },
};
