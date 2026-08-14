import assert from "node:assert/strict";
import { test } from "node:test";
import { routeToModel } from "./router";

test("routes coding requests to claude", () => {
  assert.equal(routeToModel("Can you help me debug this Python function?"), "claude");
  assert.equal(routeToModel("I'm getting a stack trace in my React app"), "claude");
  assert.equal(routeToModel("Write a SQL query to join two tables"), "claude");
});

test("routes general requests to chatgpt", () => {
  assert.equal(routeToModel("Summarize this article for me"), "chatgpt");
  assert.equal(routeToModel("What should I make for dinner tonight?"), "chatgpt");
  assert.equal(routeToModel("Help me write a birthday message for my mum"), "chatgpt");
});

test("is case-insensitive", () => {
  assert.equal(routeToModel("DEBUG this JavaScript error"), "claude");
});

test("matches on substring, not whole word", () => {
  assert.equal(routeToModel("My code review is due tomorrow"), "claude");
});
