import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { routeIntent } = await jiti.import("./live-routing.ts");

test("status dispatches nothing and touches no lifecycle", () => {
  // The whole point of the design: asking about progress must not interrupt it.
  const r = routeIntent("status", "how's it going");
  assert.equal(r.action, null);
  assert.equal(r.lifecycle, "none");
  assert.equal(r.text, undefined, "a status query carries no text to the agent");
});

test("abort cancels the lifecycle", () => {
  const r = routeIntent("abort", "stop");
  assert.equal(r.action, "onAbort");
  assert.equal(r.lifecycle, "cancel", "cancel, not end, so drained events are suppressed");
});

test("steer passes text through without touching the lifecycle", () => {
  const r = routeIntent("steer", "also check the tests");
  assert.equal(r.action, "onSteer");
  assert.equal(r.text, "also check the tests");
  assert.equal(r.lifecycle, "none", "steering continues the running turn");
});

test("follow_up passes text through without touching the lifecycle", () => {
  const r = routeIntent("follow_up", "when you're done update the readme");
  assert.equal(r.action, "onFollowUp");
  assert.equal(r.text, "when you're done update the readme");
  assert.equal(r.lifecycle, "none");
});

test("prompt begins a turn", () => {
  const r = routeIntent("prompt", "write a test");
  assert.equal(r.action, "onPrompt");
  assert.equal(r.text, "write a test");
  assert.equal(r.lifecycle, "begin");
});

test("only prompt begins a turn and only abort cancels one", () => {
  const intents = ["status", "abort", "steer", "follow_up", "prompt"];
  const begins = intents.filter((i) => routeIntent(i, "x").lifecycle === "begin");
  const cancels = intents.filter((i) => routeIntent(i, "x").lifecycle === "cancel");
  assert.deepEqual(begins, ["prompt"]);
  assert.deepEqual(cancels, ["abort"]);
});

test("only status leaves the agent untouched", () => {
  for (const intent of ["abort", "steer", "follow_up", "prompt"]) {
    assert.notEqual(routeIntent(intent, "x").action, null, `${intent} must dispatch something`);
  }
});

test("an unknown intent falls back to prompt rather than doing nothing", () => {
  // Fail open: an unrecognised label should behave like a normal request, never
  // like a silent no-op (the user would just be ignored).
  const r = routeIntent("nonsense", "hello");
  assert.equal(r.action, "onPrompt");
  assert.equal(r.lifecycle, "begin");
});

test("text is preserved verbatim, including punctuation and case", () => {
  const text = "Also, check the Docs — and don't skip tests.";
  assert.equal(routeIntent("steer", text).text, text);
  assert.equal(routeIntent("prompt", text).text, text);
});

test("empty text is passed through unchanged, not invented or dropped", () => {
  // Emptiness is the caller's problem (it should not dispatch); the router must
  // not silently substitute anything.
  assert.equal(routeIntent("prompt", "").text, "");
});
