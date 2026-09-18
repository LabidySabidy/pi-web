import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

// The route imports the pi SDK and the session registry, so behaviour is
// covered where it lives: `sessionLikeFromState` is pure and tested directly
// here, and the wiring is asserted against source (the convention this repo
// already uses for routes with heavy dependencies -- see
// app/api/sessions/context-route.test.mjs).
const routeSrc = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { sessionLikeFromState } = await jiti.import("./route.ts");

// ---------------------------------------------------------------------------
// sessionLikeFromState -- the get_state payload adapter
// ---------------------------------------------------------------------------

test("a streaming state maps to a streaming session", () => {
  const out = sessionLikeFromState({ isStreaming: true });
  assert.equal(out.isStreaming, true);
});

test("isPromptRunning maps to a pending prompt", () => {
  // get_state reports a boolean; the snapshot wants an acceptance count.
  assert.equal(sessionLikeFromState({ isPromptRunning: true }).pendingMessageCount, 1);
  assert.equal(sessionLikeFromState({ isPromptRunning: false }).pendingMessageCount, 0);
});

test("bash and compaction flags pass through", () => {
  const out = sessionLikeFromState({ isBashRunning: true, isCompacting: true });
  assert.equal(out.isBashRunning, true);
  assert.equal(out.isCompacting, true);
});

test("a numeric context percent is exposed", () => {
  const out = sessionLikeFromState({ contextUsage: { percent: 83 } });
  assert.deepEqual(out.getContextUsage?.(), { percent: 83 });
});

test("a null context percent yields null, not zero", () => {
  // After compaction the figure is genuinely unknown. Reporting 0 would read as
  // "plenty of room" and suppress the warning that exists to prevent a surprise.
  assert.equal(sessionLikeFromState({ contextUsage: { percent: null } }).getContextUsage?.(), null);
  assert.equal(sessionLikeFromState({ contextUsage: null }).getContextUsage?.(), null);
  assert.equal(sessionLikeFromState({}).getContextUsage?.(), null);
});

test("an empty state degrades to an idle session", () => {
  const out = sessionLikeFromState({});
  assert.equal(out.isStreaming, false);
  assert.equal(out.pendingMessageCount, 0);
  assert.equal(out.isBashRunning, false);
  assert.equal(out.isCompacting, false);
  assert.equal(out.getContextUsage?.(), null);
});

test("a non-numeric context percent is ignored", () => {
  assert.equal(sessionLikeFromState({ contextUsage: { percent: "83" } }).getContextUsage?.(), null);
});

// ---------------------------------------------------------------------------
// wiring -- asserted against source, since the route needs the SDK
// ---------------------------------------------------------------------------

test("the route reads state through the public RPC surface, not inner", () => {
  assert.match(routeSrc, /session\.send\(\{ type: "get_state" \}\)/);
  assert.ok(!/\.inner\b/.test(routeSrc), "must not reach into the wrapper's internals");
});

test("a get_state failure does not fail the status reply", () => {
  // Mid-replacement or busy sessions are normal; a status query must still answer.
  assert.match(routeSrc, /catch \{[\s\S]*?state = \{\};/);
});

test("status never dispatches to the session", () => {
  // The whole point: answering must not append a message or start a turn.
  for (const forbidden of ['type: "prompt"', 'type: "steer"', 'type: "follow_up"', 'type: "abort"']) {
    assert.ok(
      !routeSrc.includes(forbidden),
      `status route must not send ${forbidden}`,
    );
  }
  assert.match(routeSrc, /\.send\(\{ type: "get_state" \}\)/, "get_state is the only command sent");
});

test("synthesis skips the summarizer", () => {
  // Direct Piper, not /api/speak: a status report is already speech-ready and
  // the extra model call costs a measured ~930ms.
  assert.match(routeSrc, /synthesizeSpeech\(text, voice\)/);
  assert.ok(!routeSrc.includes("speakText"), "must not run the summarize-then-speak path");
});

test("the origin guard and Piper status come from the shared modules", () => {
  assert.match(routeSrc, /import \{ isApiRequestAllowed \} from "@\/lib\/request-security"/);
  assert.match(routeSrc, /import \{ getPiperStatus, synthesizeSpeech, PiperError \} from "@\/lib\/piper-tts"/);
});

test("voice is optional and never sent as an empty string", () => {
  assert.match(routeSrc, /\|\| undefined;/);
});

test("the spoken report is length-guarded before synthesis", () => {
  assert.match(routeSrc, /MAX_STATUS_WORDS = \d+/);
  assert.match(routeSrc, /wordCount\(text\) > MAX_STATUS_WORDS/);
});

test("the silent form returns the text so it can be asserted without synthesis", () => {
  assert.match(routeSrc, /searchParams\.get\("speak"\) !== "1"/);
  assert.match(routeSrc, /NextResponse\.json\(\{ text, snapshot \}\)/);
});
