import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// `voice-intent-model.ts` imports the pi SDK, which is not needed to test the
// wrapper's behaviour -- an injected `classify` replaces the model call. jiti
// resolves the SDK import fine at load time (it is a declared dependency).
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { classifyVoiceIntent } = await jiti.import("./voice-intent-model.ts");

const idle = { isStreaming: false };
const running = { isStreaming: true, turnAgeMs: 5000 };

/** Records whether the model was consulted, so we can assert on call counts. */
function stubModel(reply, { throws = null } = {}) {
  const calls = [];
  return {
    calls,
    classify: async (transcript, context) => {
      calls.push({ transcript, context });
      if (throws) throw new Error(throws);
      return reply;
    },
  };
}

test("a fast-path utterance never reaches the model", async () => {
  const stub = stubModel('{"intent":"prompt","confidence":1}');
  const r = await classifyVoiceIntent("stop", running, { classify: stub.classify });
  assert.equal(r.intent, "abort");
  assert.equal(r.source, "fast-path");
  assert.equal(stub.calls.length, 0, "model must not be called for a fast-path hit");
});

test("a status question never reaches the model", async () => {
  const stub = stubModel('{"intent":"prompt","confidence":1}');
  const r = await classifyVoiceIntent("how's it going", running, { classify: stub.classify });
  assert.equal(r.intent, "status");
  assert.equal(stub.calls.length, 0);
});

test("an ambiguous utterance does reach the model", async () => {
  const stub = stubModel('{"intent":"steer","confidence":0.8}');
  const r = await classifyVoiceIntent("the parser looks wrong to me", running, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "steer");
  assert.equal(r.source, "model");
  assert.equal(stub.calls.length, 1);
});

test("a model error falls back without throwing", async () => {
  const stub = stubModel("", { throws: "classifier exploded" });
  const r = await classifyVoiceIntent("some unique phrasing here", running, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "follow_up");
  assert.equal(r.source, "fallback");
  assert.equal(r.reason, "classifier exploded");
});

test("an unparseable reply falls back without throwing", async () => {
  const stub = stubModel("I think the user wants to steer this");
  const r = await classifyVoiceIntent("some unique phrasing here", running, {
    classify: stub.classify,
  });
  assert.equal(r.source, "fallback");
  assert.equal(r.intent, "follow_up");
});

test("a low-confidence abort from the model is downgraded to steer", async () => {
  const stub = stubModel('{"intent":"abort","confidence":0.3}');
  const r = await classifyVoiceIntent("i think maybe we should reconsider", running, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "steer");
  assert.equal(r.reason, "abort-below-threshold");
});

test("a high-confidence abort while running is honoured", async () => {
  const stub = stubModel('{"intent":"abort","confidence":0.95}');
  const r = await classifyVoiceIntent("cease all work on the parser", running, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "abort");
});

test("an abort while idle becomes a prompt rather than a no-op cancel", async () => {
  const stub = stubModel('{"intent":"abort","confidence":0.99}');
  const r = await classifyVoiceIntent("cease all work on the parser", idle, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "prompt");
  assert.equal(r.reason, "abort-without-run");
});

test("steering while idle becomes a prompt", async () => {
  const stub = stubModel('{"intent":"steer","confidence":0.9}');
  const r = await classifyVoiceIntent("something quite unusual to say", idle, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "prompt");
});

test("a fenced JSON reply is still parsed", async () => {
  const stub = stubModel('```json\n{"intent":"follow_up","confidence":0.7}\n```');
  const r = await classifyVoiceIntent("some unusual phrasing indeed", running, {
    classify: stub.classify,
  });
  assert.equal(r.intent, "follow_up");
  assert.equal(r.source, "model");
});

test("the classifier passes the live context through to the model", async () => {
  const stub = stubModel('{"intent":"prompt","confidence":0.6}');
  const ctx = { isStreaming: true, turnAgeMs: 1234, lastAssistantText: "working on it" };
  await classifyVoiceIntent("a wholly novel sentence", ctx, { classify: stub.classify });
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].context, ctx);
  assert.equal(stub.calls[0].transcript, "a wholly novel sentence");
});
