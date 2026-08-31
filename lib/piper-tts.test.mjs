import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { buildPiperServerArgs, listVoicesFromDir, derivePiperStatus } = await jiti.import("./piper-tts.ts");

test("buildPiperServerArgs emits the http_server invocation", () => {
  const args = buildPiperServerArgs({
    python: "X",
    host: "127.0.0.1",
    port: 8766,
    voicesDir: "/v",
    defaultVoice: "en_US-lessac-medium",
  });
  assert.deepEqual(args, [
    "-m", "piper.http_server",
    "--host", "127.0.0.1",
    "--port", "8766",
    "-m", "en_US-lessac-medium",
    "--data-dir", "/v",
  ]);
});

test("listVoicesFromDir lists .onnx voices sorted, skipping config files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "piper-voices-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "en_US-ryan-medium.onnx"), "x");
  await writeFile(path.join(dir, "en_US-amy-medium.onnx"), "x");
  await writeFile(path.join(dir, "en_US-lessac-medium.onnx.json"), "y"); // excluded
  assert.deepEqual(listVoicesFromDir(dir), ["en_US-amy-medium", "en_US-ryan-medium"]);
});

test("listVoicesFromDir returns [] for a missing dir", () => {
  assert.deepEqual(listVoicesFromDir(path.join(os.tmpdir(), "piper-missing-xyz")), []);
});

test("derivePiperStatus maps availability/running/error", () => {
  const base = { available: true, serving: false, error: null, voices: ["a"], defaultVoice: "a" };
  assert.equal(derivePiperStatus({ ...base, available: false }).available, false);
  assert.equal(derivePiperStatus(base).running, false);
  assert.equal(derivePiperStatus({ ...base, serving: true }).running, true);
  assert.equal(derivePiperStatus({ ...base, error: "boom" }).error, "boom");
});
