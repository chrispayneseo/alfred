import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorSummary } from "../safeErrorSummary.js";

test("error logging omits messages and nested request credentials", () => {
  const error = Object.assign(new Error("refresh_token=private-token"), {
    status: 400,
    config: { data: { refresh_token: "private-token" } },
  });
  assert.deepEqual(safeErrorSummary(error), { type: "Error", status: 400 });
  assert.ok(!JSON.stringify(safeErrorSummary(error)).includes("private-token"));
});
