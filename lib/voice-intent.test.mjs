import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  ABORT_CONFIDENCE_THRESHOLD,
  buildClassifyPrompt,
  classifyLocally,
  decideIntent,
  isVoiceIntent,
  normaliseTranscript,
  parseClassifyResponse,
} = await jiti.import("./voice-intent.ts");

const idle = { isStreaming: false };
const running = { isStreaming: true, turnAgeMs: 4000 };

// ---------------------------------------------------------------------------
// normaliseTranscript
// ---------------------------------------------------------------------------

test("normaliseTranscript lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(normaliseTranscript("  Stop!  "), "stop");
  assert.equal(normaliseTranscript("How's   it going?"), "how's it going?");
  assert.equal(normaliseTranscript(""), "");
  assert.equal(normaliseTranscript("!!! ???"), "");
});

test("normaliseTranscript keeps apostrophes and question marks", () => {
  assert.equal(normaliseTranscript("When you're done, do X"), "when you're done do x");
  assert.equal(normaliseTranscript("don't"), "don't");
  assert.equal(normaliseTranscript("How's it going?"), "how's it going?");
});

// ---------------------------------------------------------------------------
// abort fast path -- exact phrases only
// ---------------------------------------------------------------------------

test("exact stop phrases abort at full confidence, idle or running", () => {
  for (const phrase of ["stop", "Stop!", "hold on", "cancel that", "never mind", "wait"]) {
    for (const ctx of [idle, running]) {
      const r = classifyLocally(phrase, ctx);
      assert.equal(r?.intent, "abort", `"${phrase}" should abort`);
      assert.equal(r?.confidence, 1);
      assert.equal(r?.source, "fast-path");
    }
  }
});

test("a stop word inside a larger instruction is NOT an abort", () => {
  // The whole point of exact-phrase matching: these must not kill a running
  // task, because they ask for work rather than cessation.
  for (const phrase of [
    "stop the build",
    "dont stop the tests",
    "don't skip the docs",
    "wait for the build then continue",
    "cancel the timeout handling",
  ]) {
    const r = classifyLocally(phrase, running);
    assert.notEqual(r?.intent, "abort", `"${phrase}" must not abort`);
  }
});

test("a trailing question mark still aborts", () => {
  assert.equal(classifyLocally("stop?", running)?.intent, "abort");
});

// ---------------------------------------------------------------------------
// status fast path
// ---------------------------------------------------------------------------

test("progress questions classify as status and never dispatch work", () => {
  for (const phrase of [
    "how's it going",
    "how is it going",
    "what are you working on",
    "any progress",
    "status",
    "where are you at",
    "are you done yet",
    "how much longer",
    "give me an update",
    "talk to me",
    "what have you done so far",
  ]) {
    const r = classifyLocally(phrase, running);
    assert.equal(r?.intent, "status", `"${phrase}" should be status`);
  }
});

test("status is detected while idle too", () => {
  assert.equal(classifyLocally("how's it going", idle)?.intent, "status");
});

// ---------------------------------------------------------------------------
// follow_up beats steer when both cues appear
// ---------------------------------------------------------------------------

test("a completion cue wins over an also-cue", () => {
  // "after you're done, also do X" contains both; the weaker must not win.
  const r = classifyLocally("after you're done also update the readme", running);
  assert.equal(r?.intent, "follow_up");
});

test("follow-up phrasings while a run is active", () => {
  for (const phrase of [
    "when you're done update the readme",
    "once you finish commit the changes",
    "after that run the tests",
    "afterwards write a summary",
    "when you get a chance clean up the imports",
  ]) {
    assert.equal(classifyLocally(phrase, running)?.intent, "follow_up", phrase);
  }
});

test("a completion cue while idle is just a request, not a queue", () => {
  assert.equal(classifyLocally("after you finish update the readme", idle), null);
});

// ---------------------------------------------------------------------------
// steer fast path
// ---------------------------------------------------------------------------

test("modification cues steer only while a run is active", () => {
  for (const phrase of [
    "also check the tests",
    "skip the docs",
    "use the other file",
    "instead use fast refresh",
    "make sure the build passes",
    "revert that change",
  ]) {
    assert.equal(classifyLocally(phrase, running)?.intent, "steer", phrase);
    assert.equal(classifyLocally(phrase, idle), null, `${phrase} (idle)`);
  }
});

// ---------------------------------------------------------------------------
// decideIntent safety downgrades
// ---------------------------------------------------------------------------

test("an unconfident abort is downgraded to steer, never executed", () => {
  const r = decideIntent({
    transcript: "only update the docs maybe",
    context: running,
    modelResult: { intent: "abort", confidence: 0.4 },
  });
  assert.equal(r.intent, "steer");
  assert.equal(r.reason, "abort-below-threshold");
});

test("a confident abort is honoured while running", () => {
  const r = decideIntent({
    transcript: "please cease all operations immediately",
    context: running,
    modelResult: { intent: "abort", confidence: 0.97 },
  });
  assert.equal(r.intent, "abort");
});

test("the abort threshold is the documented boundary", () => {
  const below = decideIntent({
    transcript: "hmm",
    context: running,
    modelResult: { intent: "abort", confidence: ABORT_CONFIDENCE_THRESHOLD - 0.01 },
  });
  const at = decideIntent({
    transcript: "hmm",
    context: running,
    modelResult: { intent: "abort", confidence: ABORT_CONFIDENCE_THRESHOLD },
  });
  assert.equal(below.intent, "steer");
  assert.equal(at.intent, "abort");
});

test("abort while idle becomes a normal prompt (nothing to stop)", () => {
  const r = decideIntent({
    transcript: "cease operations immediately",
    context: idle,
    modelResult: { intent: "abort", confidence: 0.99 },
  });
  assert.equal(r.intent, "prompt");
  assert.equal(r.reason, "abort-without-run");
});

test("steer and follow_up while idle degrade to prompt", () => {
  for (const intent of ["steer", "follow_up"]) {
    const r = decideIntent({
      transcript: "do something else entirely",
      context: idle,
      modelResult: { intent, confidence: 0.95 },
    });
    assert.equal(r.intent, "prompt", intent);
    assert.equal(r.reason, "no-run");
  }
});

test("a fast-path hit short-circuits the model result", () => {
  const r = decideIntent({
    transcript: "hold on",
    context: running,
    modelResult: { intent: "prompt", confidence: 0.99 },
  });
  assert.equal(r.intent, "abort");
  assert.equal(r.source, "fast-path");
});

test("a negated stop word escalates to the model rather than guessing", () => {
  // "don't stop the build" contains a steer cue ("the build") and a negation of
  // an abort word. The fast path must decline so the model can rule -- guessing
  // here is what kills a running task.
  assert.equal(classifyLocally("dont stop the build", running), null);
  assert.equal(classifyLocally("don't stop the tests", running), null);
});

// ---------------------------------------------------------------------------
// fallback behaviour -- the model is unusable
// ---------------------------------------------------------------------------

test("no model result while streaming falls back to follow_up, never prompt", () => {
  // A bare prompt during streaming is rejected by rpc-manager (it needs
  // streamingBehavior), and guessing abort would kill work. follow_up is the
  // only non-destructive, always-legal choice.
  const r = decideIntent({ transcript: "something convoluted", context: running, modelResult: null });
  assert.equal(r.intent, "follow_up");
  assert.equal(r.source, "fallback");
});

test("no model result while idle falls back to prompt", () => {
  const r = decideIntent({ transcript: "something convoluted", context: idle, modelResult: null });
  assert.equal(r.intent, "prompt");
  assert.equal(r.source, "fallback");
});

test("a model error is reported and falls back", () => {
  const r = decideIntent({
    transcript: "unique phrasing",
    context: running,
    modelResult: null,
    modelError: "timeout",
  });
  assert.equal(r.intent, "follow_up");
  assert.equal(r.reason, "timeout");
});

test("fallback never yields abort, for any context", () => {
  for (const ctx of [idle, running]) {
    for (const err of [undefined, "boom"]) {
      const r = decideIntent({ transcript: "unclassifiable", context: ctx, modelResult: null, modelError: err });
      assert.notEqual(r.intent, "abort");
    }
  }
});

test("confidence is clamped and NaN is rejected", () => {
  const high = decideIntent({
    transcript: "unique",
    context: running,
    modelResult: { intent: "steer", confidence: 5 },
  });
  assert.equal(high.confidence, 1);

  const nan = decideIntent({
    transcript: "unique",
    context: running,
    modelResult: { intent: "steer", confidence: Number.NaN },
  });
  assert.equal(nan.confidence, 0);
});

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

test("parseClassifyResponse accepts bare JSON", () => {
  assert.deepEqual(parseClassifyResponse('{"intent":"steer","confidence":0.8}'), {
    intent: "steer",
    confidence: 0.8,
  });
});

test("parseClassifyResponse tolerates fences and surrounding prose", () => {
  const raw = 'Here you go:\n```json\n{"intent":"status","confidence":0.75}\n```\nDone.';
  assert.deepEqual(parseClassifyResponse(raw), { intent: "status", confidence: 0.75 });
});

test("parseClassifyResponse defaults a missing confidence to 0.5", () => {
  assert.deepEqual(parseClassifyResponse('{"intent":"prompt"}'), {
    intent: "prompt",
    confidence: 0.5,
  });
});

test("parseClassifyResponse rejects unknown labels and malformed input", () => {
  for (const raw of ['{"intent":"destroy","confidence":1}', "not json", "", '{"intent":123}', "[]"]) {
    assert.equal(parseClassifyResponse(raw), null, raw);
  }
});

test("isVoiceIntent validates the label set", () => {
  assert.equal(isVoiceIntent("steer"), true);
  assert.equal(isVoiceIntent("destroy"), false);
  assert.equal(isVoiceIntent(42), false);
});

// ---------------------------------------------------------------------------
// prompt construction
// ---------------------------------------------------------------------------

test("buildClassifyPrompt states the running/idle condition", () => {
  const streaming = buildClassifyPrompt("do a thing", { isStreaming: true, turnAgeMs: 12_000 });
  assert.match(streaming, /CURRENTLY RUNNING/);
  assert.match(streaming, /started 12s ago/);

  const whenIdle = buildClassifyPrompt("do a thing", idle);
  assert.match(whenIdle, /IDLE/);
});

test("buildClassifyPrompt embeds the utterance verbatim", () => {
  const p = buildClassifyPrompt("skip the docs please", running);
  assert.ok(p.includes("skip the docs please"));
});

test("buildClassifyPrompt bounds the assistant context it includes", () => {
  const huge = "x".repeat(5000);
  const p = buildClassifyPrompt("status", { isStreaming: true, lastAssistantText: huge });
  // Must not blow up the prompt with an unbounded transcript.
  assert.ok(p.length < 3000, `prompt too long: ${p.length}`);
  assert.ok(p.includes('"""'));
});
