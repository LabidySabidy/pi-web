import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { PlaybackGate } = await jiti.import("./playback-gate.ts");

test("a fresh gate is inactive", () => {
  const g = new PlaybackGate();
  assert.equal(g.isActive, false);
});

test("begin activates and returns a token", () => {
  const g = new PlaybackGate();
  const token = g.begin();
  assert.equal(g.isActive, true);
  assert.equal(typeof token, "number");
});

test("a natural finish reports end exactly once", () => {
  const g = new PlaybackGate();
  const token = g.begin();
  assert.equal(g.finish(token), "end");
  assert.equal(g.isActive, false);
  assert.equal(g.finish(token), null, "a repeat finish must not report again");
});

test("stopping an active utterance reports end", () => {
  const g = new PlaybackGate();
  g.begin();
  assert.equal(g.stop(), "end");
  assert.equal(g.isActive, false);
});

test("stopping when nothing plays reports nothing", () => {
  const g = new PlaybackGate();
  assert.equal(g.stop(), null);
});

test("the browser's late onended after a stop does not announce a second end", () => {
  // The race this class exists for: stop() settles the promise, then the audio
  // element reports onended for the audio that was interrupted.
  const g = new PlaybackGate();
  const token = g.begin();
  assert.equal(g.stop(), "end");
  assert.equal(g.finish(token), null, "late onended must be ignored");
});

test("replacing audio discards the previous utterance's completion", () => {
  const g = new PlaybackGate();
  const first = g.begin();
  const second = g.begin(); // barge-in replaced it
  assert.equal(g.finish(first), null, "the superseded utterance must not complete");
  assert.equal(g.isActive, true, "the new utterance is still playing");
  assert.equal(g.finish(second), "end");
});

test("a superseded utterance cannot clear the new one's state", () => {
  const g = new PlaybackGate();
  const first = g.begin();
  const second = g.begin();
  g.finish(first); // ignored
  assert.equal(g.isActive, true);
  g.finish(second);
  assert.equal(g.isActive, false);
});

test("repeated stop calls report end once", () => {
  const g = new PlaybackGate();
  g.begin();
  assert.equal(g.stop(), "end");
  assert.equal(g.stop(), null);
  assert.equal(g.stop(), null);
});

test("stop then begin then finish is a clean cycle", () => {
  const g = new PlaybackGate();
  g.begin();
  g.stop();
  const token = g.begin();
  assert.equal(g.finish(token), "end");
});

test("ten interruption cycles each report exactly one end", () => {
  const g = new PlaybackGate();
  let ends = 0;
  for (let i = 0; i < 10; i++) {
    const token = g.begin();
    if (g.stop() === "end") ends += 1;
    g.finish(token); // late onended
  }
  assert.equal(ends, 10, "one end per interruption, no doubles");
  assert.equal(g.isActive, false);
});

test("generations advance monotonically so tokens never collide", () => {
  const g = new PlaybackGate();
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    seen.add(g.begin());
    g.stop();
  }
  assert.equal(seen.size, 20, "every token must be unique");
});
