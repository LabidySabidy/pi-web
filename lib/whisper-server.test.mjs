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

const {
  resolveWhisperConfig,
  listWhisperModels,
  resolveModelChoice,
  deriveWhisperStatus,
  buildMultipartFormData,
  cleanTranscription,
} = await jiti.import("./whisper-server.ts");

const isWin = process.platform === "win32";

test("resolveWhisperConfig defaults to the repo-local whisper dir", () => {
  const base = isWin ? "C:\\dev\\pi-web" : "/dev/pi-web";
  const cfg = resolveWhisperConfig({}, base, "win32");
  assert.equal(cfg.rootDir, path.join(base, "whisper"));
  assert.equal(cfg.serverPath, path.join(base, "whisper", "bin", "whisper-server.exe"));
  assert.equal(cfg.modelDir, path.join(base, "whisper", "models"));
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8765);
  assert.equal(cfg.defaultModel, "ggml-base.en.bin");
});

test("resolveWhisperConfig uses a non-.exe server name on macOS/Linux", () => {
  const base = "/dev/pi-web";
  const cfg = resolveWhisperConfig({}, base, "darwin");
  assert.equal(cfg.rootDir, path.join(base, "whisper"));
  assert.equal(cfg.serverPath, path.join(base, "whisper", "bin", "whisper-server"));
  assert.equal(cfg.modelDir, path.join(base, "whisper", "models"));
});

test("resolveWhisperConfig honors env overrides", () => {
  const base = isWin ? "C:\\dev\\pi-web" : "/dev/pi-web";
  const cfg = resolveWhisperConfig({
    WHISPER_VTT_ROOT: isWin ? "D:\\whisper" : "/opt/whisper",
    WHISPER_SERVER_PATH: isWin ? "D:\\bin\\ws.exe" : "/opt/bin/ws",
    WHISPER_MODEL_DIR: isWin ? "D:\\models" : "/opt/models",
    WHISPER_HOST: "0.0.0.0",
    WHISPER_PORT: "9123",
  }, base);
  assert.equal(cfg.rootDir, isWin ? "D:\\whisper" : "/opt/whisper");
  assert.equal(cfg.serverPath, isWin ? "D:\\bin\\ws.exe" : "/opt/bin/ws");
  assert.equal(cfg.modelDir, isWin ? "D:\\models" : "/opt/models");
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 9123);
});

test("resolveWhisperConfig falls back to default port for invalid WHISPER_PORT", () => {
  const cfg = resolveWhisperConfig({ WHISPER_PORT: "not-a-number" }, "/dev/pi-web");
  assert.equal(cfg.port, 8765);
});

test("listWhisperModels returns only ggml/gguf models sorted by name", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-web-models-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "ggml-tiny.en.bin"), "x");
  await writeFile(path.join(dir, "ggml-base.en.bin"), "yy");
  await writeFile(path.join(dir, "tiny.en.pt"), "pytorch"); // excluded
  await writeFile(path.join(dir, "base.en.pt"), "pytorch"); // excluded
  await writeFile(path.join(dir, "ggml-base.en-q5_0.gguf"), "z"); // included
  const models = listWhisperModels(dir);
  assert.deepEqual(
    models.map((m) => m.name),
    ["ggml-base.en-q5_0.gguf", "ggml-base.en.bin", "ggml-tiny.en.bin"],
  );
  for (const m of models) assert.equal(typeof m.path, "string");
  assert.equal(models.find((m) => m.name === "ggml-tiny.en.bin").bytes, 1);
});

test("listWhisperModels returns [] for a missing dir", () => {
  assert.deepEqual(listWhisperModels(path.join(os.tmpdir(), "pi-web-missing-xyz")), []);
});

test("resolveModelChoice matches by exact name", () => {
  const models = [
    { name: "ggml-tiny.en.bin", path: "/m/tiny", bytes: 1 },
    { name: "ggml-base.en.bin", path: "/m/base", bytes: 2 },
  ];
  const { model, error } = resolveModelChoice("ggml-tiny.en.bin", models);
  assert.equal(error, undefined);
  assert.equal(model.name, "ggml-tiny.en.bin");
});

test("resolveModelChoice rejects unknown names", () => {
  const models = [{ name: "ggml-base.en.bin", path: "/m/base", bytes: 2 }];
  const { model, error } = resolveModelChoice("ggml-fake.bin", models);
  assert.equal(model, undefined);
  assert.match(error, /Unknown model/);
});

test("resolveModelChoice treats empty/absent as no explicit choice", () => {
  const models = [{ name: "ggml-base.en.bin", path: "/m/base", bytes: 2 }];
  assert.equal(resolveModelChoice(null, models).model, undefined);
  assert.equal(resolveModelChoice("", models).model, undefined);
  assert.equal(resolveModelChoice(undefined, models).error, undefined);
});

test("cleanTranscription strips no-speech markers and collapses whitespace", () => {
  assert.equal(cleanTranscription("[BLANK_AUDIO]"), "");
  assert.equal(cleanTranscription("hello   world"), "hello world");
  assert.equal(cleanTranscription("say [BLANK_AUDIO] again"), "say again");
});

test("buildMultipartFormData emits a curl-compatible file part", () => {
  const body = buildMultipartFormData("BOUNDARY", "audio.wav", "audio/wav", new Uint8Array([1, 2, 3]));
  const text = Buffer.from(body).toString("utf8");
  assert.ok(text.startsWith("--BOUNDARY\r\n"));
  assert.ok(text.includes('Content-Disposition: form-data; name="file"; filename="audio.wav"'));
  assert.ok(text.includes("Content-Type: audio/wav"));
  assert.ok(text.endsWith("--BOUNDARY--\r\n"));
  assert.deepEqual([...body.subarray(body.length - 3 - 16, body.length - 16)], [1, 2, 3]);
});

test("deriveWhisperStatus maps availability/running/warming-up", () => {
  const models = [{ name: "ggml-base.en.bin", path: "/m/base", bytes: 2 }];
  const base = {
    serverExists: true,
    models,
    currentModel: "ggml-base.en.bin",
    spawned: false,
    serving: false,
    error: null,
  };

  assert.equal(deriveWhisperStatus({ ...base, serverExists: false }).available, false);
  const noModels = deriveWhisperStatus({ ...base, models: [] });
  assert.equal(noModels.available, false);
  assert.equal(noModels.running, false);
  assert.equal(noModels.warmingUp, false);

  const idle = deriveWhisperStatus(base);
  assert.equal(idle.available, true);
  assert.equal(idle.running, false);
  assert.equal(idle.warmingUp, false);

  const warming = deriveWhisperStatus({ ...base, spawned: true, serving: false });
  assert.equal(warming.warmingUp, true);
  assert.equal(warming.running, false);

  const serving = deriveWhisperStatus({ ...base, spawned: true, serving: true });
  assert.equal(serving.running, true);
  assert.equal(serving.warmingUp, false);

  assert.equal(deriveWhisperStatus({ ...base, error: "boom" }).error, "boom");
});
