import assert from "node:assert/strict";
import test from "node:test";
import { planGatewayDecision } from "../../src/lib/gatewayDecision.js";

test("gateway cloud prompt cannot replace the user's approved text", () => {
  const plan = planGatewayDecision({
    decision: "cloud_ready",
    reason: "Needs research",
    cloud_prompt: "secret from private memory",
    memory_sent: false,
  }, "Research the latest Python release");
  assert.deepEqual(plan, {
    kind: "approval", reason: "Needs research",
    prompt: "Research the latest Python release", scope: "prompt_only",
  });
});

test("connected account requests require a separate approval", () => {
  assert.deepEqual(planGatewayDecision({
    decision: "connection_needed", reply: "This needs your calendar",
  }, "What is on my calendar?"), {
    kind: "approval", reason: "This needs your calendar",
    prompt: "What is on my calendar?", scope: "connected",
  });
});

test("local answers stay local", () => {
  assert.deepEqual(planGatewayDecision({
    decision: "local", reply: "Hello", model: "qwen3:4b", memories_used: 0,
  }, "Say hello"), { kind: "local", reply: "Hello", memoriesUsed: 0 });
});

test("local recall keeps source links without creating cloud approval", () => {
  const sources = [{ id: "memory:7", kind: "memory" as const, title: "Spare key", due: null, url: "/settings?memory=7" }];
  assert.deepEqual(planGatewayDecision({
    decision: "local", reply: "In the drawer", model: "qwen3:4b", memories_used: 1, sources,
  }, "Where is my spare key?"), {
    kind: "local", reply: "In the drawer", memoriesUsed: 1, sources,
  });
});
