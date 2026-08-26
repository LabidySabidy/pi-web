import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { isWav, POST } = await jiti.import("./route.ts");

function makeWavHeader() {
  const bytes = new Uint8Array(44);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  return bytes;
}

test("isWav accepts a RIFF/WAVE header", () => {
  assert.equal(isWav(makeWavHeader()), true);
});

test("isWav rejects non-WAV and short buffers", () => {
  assert.equal(isWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), false);
  assert.equal(isWav(new Uint8Array(4)), false);
});

test("POST rejects a non-WAV body with 400 without touching the server", async () => {
  const req = new Request("http://localhost/api/transcribe", {
    method: "POST",
    body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /WAV/);
});
