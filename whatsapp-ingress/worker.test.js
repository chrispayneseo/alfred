import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { test } from "node:test";
import worker from "./worker.js";

globalThis.crypto ??= webcrypto;

function setup() {
  const saved = new Map();
  const db = {
    prepare(query) {
      return {
        bind(...args) {
          return {
            async run() {
              if (query.startsWith("INSERT")) saved.set(args[0], { id: args[0], body: args[1], sent_at: args[2] });
              if (query.startsWith("DELETE")) saved.delete(args[0]);
            },
          };
        },
        async all() { return { results: [...saved.values()] }; },
      };
    },
  };
  const env = {
    META_APP_SECRET: "test-secret",
    META_VERIFY_TOKEN: "verify-token",
    ALLOWED_SENDER: "+44 7000 000001",
    PHONE_NUMBER_ID: "business-number-id",
    COLLECTOR_TOKEN: "a".repeat(40),
    INBOX_DB: db,
  };
  return { env, saved };
}

function signedMessage(sender = "447000000001", phoneId = "business-number-id") {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: phoneId },
      messages: [{ id: "wamid.test_message_12345678", from: sender, timestamp: "123", type: "text", text: { body: "Remember the appointment" } }],
    } }] }],
  });
  const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
  return new Request("https://ingress.example/webhook", {
    method: "POST", body,
    headers: { "x-hub-signature-256": `sha256=${signature}`, "content-type": "application/json" },
  });
}

test("Meta challenge requires the verify token", async () => {
  const { env } = setup();
  const valid = await worker.fetch(new Request("https://ingress.example/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=123"), env);
  assert.equal(await valid.text(), "123");
  const invalid = await worker.fetch(new Request("https://ingress.example/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123"), env);
  assert.equal(invalid.status, 403);
});

test("stores only signed messages from the allowed personal number", async () => {
  const { env, saved } = setup();
  assert.equal((await worker.fetch(signedMessage(), env)).status, 200);
  assert.equal(saved.size, 1);
  await worker.fetch(signedMessage("447000000002"), env);
  await worker.fetch(signedMessage("447000000001", "other-business-number"), env);
  assert.equal(saved.size, 1);
  const tampered = signedMessage();
  tampered.headers.set("x-hub-signature-256", "sha256=" + "0".repeat(64));
  assert.equal((await worker.fetch(tampered, env)).status, 401);
  assert.equal(saved.size, 1);
});

test("collector is private and acknowledgement removes the item", async () => {
  const { env, saved } = setup();
  await worker.fetch(signedMessage(), env);
  assert.equal((await worker.fetch(new Request("https://ingress.example/inbox"), env)).status, 401);
  const authorization = `Bearer ${env.COLLECTOR_TOKEN}`;
  const inbox = await worker.fetch(new Request("https://ingress.example/inbox", { headers: { authorization } }), env);
  assert.equal((await inbox.json()).messages.length, 1);
  const ack = await worker.fetch(new Request("https://ingress.example/inbox/ack", {
    method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ id: "wamid.test_message_12345678" }),
  }), env);
  assert.equal(ack.status, 200);
  assert.equal(saved.size, 0);
});
