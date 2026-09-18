import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { UtteranceSegmenter, framesForMs } = await jiti.import("./utterance-segmenter.ts");

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;

function makeSegmenter(overrides = {}) {
  return new UtteranceSegmenter({
    threshold: 0.5,
    silenceMs: 600,
    minSpeechMs: 250,
    maxUtteranceMs: 60_000,
    frameSamples: FRAME_SAMPLES,
    sampleRate: SAMPLE_RATE,
    ...overrides,
  });
}

/** A frame whose samples are all `value`, so we can identify it after assembly. */
function frame(value) {
  return Float32Array.from({ length: FRAME_SAMPLES }, () => value);
}

const SPEECH = 0.9;
const SILENCE = 0.05;

test("framesForMs converts a duration window into frame counts", () => {
  // 600ms at 16kHz with 512-sample frames = 18.75 -> 19 frames
  assert.equal(framesForMs(600, SAMPLE_RATE, FRAME_SAMPLES), 19);
  assert.equal(framesForMs(0, SAMPLE_RATE, FRAME_SAMPLES), 0);
  assert.equal(framesForMs(-5, SAMPLE_RATE, FRAME_SAMPLES), 0);
});

test("a lone silence frame produces nothing", () => {
  const s = makeSegmenter();
  assert.deepEqual(s.push(frame(0), SILENCE, 0), []);
  assert.equal(s.isActive, false);
});

test("speech emits speech-start exactly once", () => {
  const s = makeSegmenter();
  const first = s.push(frame(0), SPEECH, 0);
  assert.deepEqual(first.map((e) => e.type), ["speech-start"]);
  assert.equal(s.isActive, true);

  const second = s.push(frame(0), SPEECH, 10);
  assert.deepEqual(second, [], "no second speech-start while already active");
});

test("trailing silence of the configured length closes the utterance", () => {
  const s = makeSegmenter({ silenceMs: 600 });
  const silenceFrames = framesForMs(600, SAMPLE_RATE, FRAME_SAMPLES); // 19
  assert.ok(silenceFrames < 25, "sanity: window is small enough for a fast test");

  s.push(frame(1), SPEECH, 0);
  let events = [];
  for (let i = 0; i < silenceFrames - 1; i++) {
    events = s.push(frame(0), SILENCE, 10 * (i + 1));
    assert.deepEqual(events, [], `frame ${i} should not close yet`);
  }
  const closing = s.push(frame(0), SILENCE, 10 * silenceFrames);
  assert.equal(closing.length, 1);
  assert.equal(closing[0].type, "speech-end");
  assert.equal(s.isActive, false);
});

test("an utterance shorter than minSpeechMs is discarded, not delivered", () => {
  // 250ms floor at 512-sample frames (~32ms each) needs ~8 frames. Give it 2.
  const s = makeSegmenter({ minSpeechMs: 250, silenceMs: 64 });
  s.push(frame(1), SPEECH, 0);
  s.push(frame(1), SPEECH, 32);

  const events = [];
  for (let i = 0; i < 5; i++) events.push(...s.push(frame(0), SILENCE, 64 + i * 32));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "discarded");
  assert.equal(events[0].reason, "too-short");
});

test("an utterance at or above the floor is delivered with its audio intact", () => {
  const s = makeSegmenter({ minSpeechMs: 200, silenceMs: 64 });
  const speechFrames = 10;
  const events = [];

  for (let i = 0; i < speechFrames; i++) events.push(...s.push(frame(0.25), SPEECH, i * 32));
  for (let i = 0; i < 5; i++) events.push(...s.push(frame(0), SILENCE, 400 + i * 32));

  const end = events.find((e) => e.type === "speech-end");
  assert.ok(end, "expected a speech-end event");
  const { utterance } = end;
  assert.equal(utterance.sampleRate, SAMPLE_RATE);
  // Speech frames plus the retained trailing-silence frames, none dropped.
  assert.ok(utterance.audio.length >= speechFrames * FRAME_SAMPLES);
  assert.equal(utterance.audio[0], 0.25, "first sample preserved");
  assert.equal(typeof utterance.durationMs, "number");
});

test("the hard cap closes a stuck-open utterance", () => {
  // 320ms cap at ~32ms/frame = 10 frames.
  const s = makeSegmenter({ maxUtteranceMs: 320, minSpeechMs: 100, silenceMs: 5000 });
  const cap = framesForMs(320, SAMPLE_RATE, FRAME_SAMPLES);

  let events = [];
  for (let i = 0; i < cap + 5; i++) {
    events.push(...s.push(frame(0.5), SPEECH, i * 32));
    if (events.some((e) => e.type === "speech-end")) break;
  }
  assert.ok(
    events.some((e) => e.type === "speech-end"),
    "the cap must close the utterance",
  );
  assert.equal(s.isActive, false);
});

test("reset drops a partial utterance so nothing is delivered", () => {
  const s = makeSegmenter();
  s.push(frame(1), SPEECH, 0);
  s.push(frame(1), SPEECH, 32);
  assert.equal(s.isActive, true);

  s.reset();
  assert.equal(s.isActive, false);

  const events = s.push(frame(0), SILENCE, 64);
  assert.deepEqual(events, [], "nothing should be emitted after a reset");
});

test("after closing, a new utterance can start", () => {
  const s = makeSegmenter({ silenceMs: 64, minSpeechMs: 100 });
  s.push(frame(1), SPEECH, 0);
  for (let i = 0; i < 5; i++) s.push(frame(1), SPEECH, 32 * (i + 1));
  for (let i = 0; i < 5; i++) s.push(frame(0), SILENCE, 300 + 32 * i);

  const restarted = s.push(frame(1), SPEECH, 900);
  assert.deepEqual(restarted.map((e) => e.type), ["speech-start"]);
});

test("preroll is prepended so a hard onset is not clipped", () => {
  const s = makeSegmenter({ silenceMs: 320, minSpeechMs: 100 });
  // Several idle frames build a preroll, then speech starts.
  for (let i = 0; i < 3; i++) s.push(frame(0.01), SILENCE, i * 32);
  const events = s.push(frame(0.75), SPEECH, 200);
  assert.deepEqual(events.map((e) => e.type), ["speech-start"]);

  for (let i = 0; i < 12; i++) s.push(frame(0.75), SPEECH, 232 + i * 32);
  const closed = [];
  for (let i = 0; i < 14; i++) closed.push(...s.push(frame(0), SILENCE, 700 + i * 32));

  const end = closed.find((e) => e.type === "speech-end");
  assert.ok(end);
  // The preroll frames should appear before the speech. Float32 cannot hold 0.01
  // exactly, so compare with a tolerance rather than by identity.
  assert.ok(
    Math.abs(end.utterance.audio[0] - 0.01) < 1e-6,
    `preroll frame should lead the utterance, got ${end.utterance.audio[0]}`,
  );
  const speechOffset = end.utterance.audio.findIndex((v) => v > 0.5);
  assert.ok(speechOffset > 0, "speech must come after the preroll");
});

test("the threshold is inclusive at the boundary", () => {
  const s = makeSegmenter({ threshold: 0.5 });
  const events = s.push(frame(1), 0.5, 0);
  assert.deepEqual(events.map((e) => e.type), ["speech-start"], "0.5 >= 0.5 counts as speech");
});
