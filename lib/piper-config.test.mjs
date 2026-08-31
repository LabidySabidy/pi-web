import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { resolvePiperConfig } = await jiti.import("./piper-config.ts");

const isWin = process.platform === "win32";

test("resolvePiperConfig defaults to the repo-local piper dir (win32)", () => {
  const base = isWin ? "C:\\dev\\pi-web" : "/dev/pi-web";
  const cfg = resolvePiperConfig({}, base, "win32");
  assert.equal(cfg.python, path.join(base, "piper", "venv", "Scripts", "python.exe"));
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8766);
  assert.equal(cfg.voicesDir, path.join(base, "piper", "voices"));
  assert.equal(cfg.defaultVoice, "en_US-lessac-medium");
});

test("resolvePiperConfig uses bin/python on macOS/Linux", () => {
  const base = isWin ? "C:\\dev\\pi-web" : "/dev/pi-web";
  const cfg = resolvePiperConfig({}, base, "darwin");
  assert.equal(cfg.python, path.join(base, "piper", "venv", "bin", "python"));
  assert.equal(cfg.voicesDir, path.join(base, "piper", "voices"));
});

test("resolvePiperConfig honors env overrides", () => {
  const cfg = resolvePiperConfig({
    PIPER_PYTHON: "C:\\py\\python.exe",
    PIPER_HOST: "0.0.0.0",
    PIPER_PORT: "9000",
    PIPER_VOICES_DIR: "D:\\voices",
    PIPER_DEFAULT_VOICE: "en_US-amy-medium",
  }, "C:\\dev", "win32");
  assert.equal(cfg.python, "C:\\py\\python.exe");
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.voicesDir, "D:\\voices");
  assert.equal(cfg.defaultVoice, "en_US-amy-medium");
});

test("resolvePiperConfig falls back to default port for invalid PIPER_PORT", () => {
  const cfg = resolvePiperConfig({ PIPER_PORT: "nope" }, "/dev", "linux");
  assert.equal(cfg.port, 8766);
});
