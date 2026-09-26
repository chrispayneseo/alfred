import assert from "node:assert/strict";
import test from "node:test";
import { planGatewayDecision, planSearchConsoleFallback } from "../../src/lib/gatewayDecision.js";

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


test("Core tool approvals never become cloud consent", () => {
  assert.deepEqual(planGatewayDecision({
    decision: "approval_required",
    reply: "I can do that, but this change needs your confirmation first.",
    reason: "Delete the uniquely resolved calendar event after owner confirmation.",
    approval: { id: "approval-123", summary: "Delete calendar event", risk_level: "external" },
    tool_action: "calendar.events.delete",
    integration: "google_calendar",
    memory_sent: false,
  }, "Delete the event"), {
    kind: "tool_approval",
    reason: "Delete the uniquely resolved calendar event after owner confirmation.",
    approvalId: "approval-123",
    action: "calendar.events.delete",
    integration: "google_calendar",
  });
});

test("an unavailable Dell offers a consented fallback for Search Console only", () => {
  assert.deepEqual(planSearchConsoleFallback("Compare Peacock Search's clicks this month with last month."), {
    kind: "approval",
    reason: "Alfred Local isn't available right now. You can still run this read-only Search Console query with your connected Google account. Dell memory and your location will stay private.",
    prompt: "Compare Peacock Search's clicks this month with last month.",
    scope: "connected",
  });
  assert.equal(planSearchConsoleFallback("Delete tomorrow's calendar event"), undefined);
});
