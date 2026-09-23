const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

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
      if (typeof id !== "string" || !/^wamid\.[A-Za-z0-9_-]{8,256}$/.test(id)) return json({ error: "invalid_id" }, 400);
      await env.INBOX_DB.prepare("DELETE FROM whatsapp_inbox WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  },
};
