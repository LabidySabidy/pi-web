import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { encodeWav, resampleTo16k, computeLevel } = await jiti.import("./audio.ts");

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

test("encodeWav writes a correct 16-bit mono PCM header", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buf = encodeWav(samples, 16000);
  const bytes = new Uint8Array(buf);

  assert.equal(buf.byteLength, 44 + samples.length * 2);
  assert.equal(ascii(bytes, 0, 4), "RIFF");
  assert.equal(ascii(bytes, 8, 4), "WAVE");
  assert.equal(ascii(bytes, 12, 4), "fmt ");
  assert.equal(ascii(bytes, 36, 4), "data");

  const view = new DataView(buf);
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000); // sample rate
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), samples.length * 2); // data size
});

test("encodeWav clamps out-of-range samples to int16", () => {
  const buf = encodeWav(new Float32Array([2, -2]), 16000);
  const view = new DataView(buf);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test("resampleTo16k is identity at 16 kHz and empty-safe", () => {
  const samples = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(resampleTo16k(samples, 16000), samples);
  assert.equal(resampleTo16k(new Float32Array(0), 48000).length, 0);
});

test("resampleTo16k halves length for 32 kHz and preserves a constant signal", () => {
  const src = new Float32Array(1000).fill(0.5);
  const out = resampleTo16k(src, 32000);
  assert.equal(out.length, 500);
  for (const v of out) assert.ok(Math.abs(v - 0.5) < 1e-6);
});

test("computeLevel is 0 for silence and clamps loud input to 1", () => {
  assert.equal(computeLevel(new Float32Array(100)), 0);
  const loud = new Float32Array(4096);
  for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i);
  assert.equal(computeLevel(loud), 1);
  const quiet = computeLevel(new Float32Array(4096).fill(0.05));
  assert.ok(quiet > 0 && quiet < 1, `expected 0 < level < 1, got ${quiet}`);
});
