#!/usr/bin/env node
/**
 * One-time setup for pi-web's offline whisper dictation engine.
 *
 * Populates `whisper/bin/` (the whisper.cpp `server` binary) and `whisper/models/`
 * (GGML model files) so `/api/transcribe` can transcribe locally.
 *
 * - Windows:      the prebuilt binaries are committed under `whisper/bin/`
 *                 (no build needed); if missing, copies them from a sibling
 *                 `../Whisper-VTT` checkout.
 * - macOS/Linux:  builds whisper.cpp's `server` example from source (needs
 *                 git + cmake + a C++ compiler).
 * - Models:       copied from a sibling `../Whisper-VTT/models` when present,
 *                 otherwise downloaded from the official whisper.cpp Hugging
 *                 Face repo.
 *
 * Usage:
 *   node scripts/setup-whisper.mjs [model ...]   # default: base.en
 *   node scripts/setup-whisper.mjs base.en tiny.en small.en
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "whisper", "bin");
const MODELS_DIR = join(ROOT, "whisper", "models");
const SIBLING = join(dirname(ROOT), "Whisper-VTT");

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const VALID_MODELS = new Set(["tiny.en", "base.en", "small.en"]);

const isWin = process.platform === "win32";

function log(...args) {
  console.log("[setup-whisper]", ...args);
}

function fail(...args) {
  console.error("[setup-whisper]", ...args);
  process.exit(1);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function run(cmd, args, opts = {}) {
  log("$", cmd, args.join(" "));
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) fail(`failed to run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} exited with status ${res.status}`);
}

function requireCommand(cmd, hint) {
  const res = spawnSync("which", [cmd], { stdio: "ignore" });
  if (res.status !== 0) fail(`${cmd} is required but not found on PATH. ${hint}`);
}

// ── Server binary ──────────────────────────────────────────────────────────

const WINDOWS_BINARIES = [
  "whisper-server.exe",
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu.dll",
];

function ensureServerBinary() {
  if (isWin) {
    const exe = join(BIN_DIR, "whisper-server.exe");
    if (existsSync(exe)) {
      log("server binary present:", exe);
      return;
    }
    const siblingRelease = join(SIBLING, "whisper-cli", "Release");
    if (existsSync(join(siblingRelease, "whisper-server.exe"))) {
      ensureDir(BIN_DIR);
      for (const file of WINDOWS_BINARIES) {
        const src = join(siblingRelease, file);
        if (existsSync(src)) copyFileSync(src, join(BIN_DIR, file));
      }
      log("copied Windows binaries from sibling:", siblingRelease);
      return;
    }
    fail("whisper-server.exe missing from whisper/bin/ — run this on a checkout with the committed binaries, or set WHISPER_SERVER_PATH");
  }

  buildServerFromSource();
}

function buildServerFromSource() {
  const target = join(BIN_DIR, "whisper-server");
  if (existsSync(target)) {
    log("server binary present:", target);
    return;
  }

  log("building whisper-server from source (needs git, cmake, and a C++ compiler)…");
  requireCommand("git", "Install it from https://git-scm.com or `xcode-select --install`.");
  requireCommand("cmake", "Install it with `brew install cmake` (and a compiler via `xcode-select --install`).");
  const buildRoot = join(ROOT, "whisper", "build");
  const srcDir = join(buildRoot, "whisper.cpp");
  ensureDir(buildRoot);

  if (!existsSync(join(srcDir, "CMakeLists.txt"))) {
    const ref = process.env.WHISPER_CPP_REF || "master";
    log(`cloning whisper.cpp @${ref} (shallow)…`);
    run("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/ggml-org/whisper.cpp.git", srcDir]);
  }

  const buildDir = join(srcDir, "build");
  run("cmake", ["-B", buildDir, "-S", srcDir, "-DWHISPER_BUILD_SERVER=ON", "-DCMAKE_BUILD_TYPE=Release"]);
  run("cmake", ["--build", buildDir, "--config", "Release", "--parallel"]);

  const candidates = [
    join(buildDir, "bin", "whisper-server"),
    join(buildDir, "bin", "Release", "whisper-server"),
  ];
  const built = candidates.find((p) => existsSync(p));
  if (!built) fail("build completed but the whisper-server binary was not found under whisper.cpp/build/bin");
  ensureDir(BIN_DIR);
  copyFileSync(built, target);
  // copyFileSync does not reliably preserve the executable bit on POSIX.
  chmodSync(target, 0o755);
  log("installed server binary:", target);
}

// ── Models ─────────────────────────────────────────────────────────────────

function modelFile(name) {
  return `ggml-${name}.bin`;
}

function siblingModelPath(file) {
  return join(SIBLING, "models", file);
}

async function downloadModel(file, dest) {
  const url = `${HF_BASE}/${file}`;
  log("downloading", url);
  ensureDir(dirname(dest));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) fail(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const out = createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out.write(Buffer.from(value));
    if (total > 0) {
      const pct = ((received / total) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}%  (${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB)   `);
    }
  }
  out.end();
  process.stdout.write("\n");
  log("saved", dest);
}

async function ensureModel(name) {
  if (!VALID_MODELS.has(name)) fail(`unknown model "${name}" — choose from: ${[...VALID_MODELS].join(", ")}`);
  const file = modelFile(name);
  const dest = join(MODELS_DIR, file);
  if (existsSync(dest)) {
    log("model present:", dest);
    return;
  }
  const sibling = siblingModelPath(file);
  if (existsSync(sibling)) {
    ensureDir(MODELS_DIR);
    copyFileSync(sibling, dest);
    log("copied model from sibling:", sibling);
    return;
  }
  await downloadModel(file, dest);
}

async function main() {
  const requested = process.argv.slice(2);
  const models = requested.length > 0 ? requested : ["base.en"];
  log("platform:", process.platform);
  ensureServerBinary();
  for (const model of models) await ensureModel(model);
  log("done — whisper dictation is ready.");
}

main().catch((err) => {
  console.error("[setup-whisper]", err);
  process.exit(1);
});
