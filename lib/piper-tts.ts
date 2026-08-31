/**
 * Piper TTS bridge — spawns `python -m piper.http_server` (the piper-tts
 * package's bundled Flask server) and POSTs text to `/synthesize` for WAV
 * audio. Mirrors `lib/whisper-server.ts`'s globalThis singleton so the process
 * (and its warm model) survives Next.js hot-reload.
 *
 * Server-only module: imports `node:*`. Only imported by API route handlers
 * and `instrumentation.ts` — never by client components.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolvePiperConfig, type PiperConfig } from "./piper-config";

const SYNTHESIZE_PATH = "/synthesize";
const POLL_INTERVAL_MS = 500;
const SERVE_TIMEOUT_MS = 60_000;

export interface PiperStatus {
  available: boolean;
  running: boolean;
  error: string | null;
  voices: string[];
  defaultVoice: string;
}

interface PiperSingleton {
  config: PiperConfig;
  child: ChildProcess | null;
  serving: boolean;
  error: string | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

const globalForPiper = globalThis as unknown as { __piperServer?: PiperSingleton };

export class PiperError extends Error {}

// ============================================================================
// Pure helpers (tested)
// ============================================================================

/** Spawn args for `python -m piper.http_server`, bound to the venv + voices. */
export function buildPiperServerArgs(config: PiperConfig): string[] {
  return [
    "-m", "piper.http_server",
    "--host", config.host,
    "--port", String(config.port),
    "-m", config.defaultVoice,
    "--data-dir", config.voicesDir,
  ];
}

/** Voice ids = `<name>.onnx` files in the voices dir, sorted. */
export function listVoicesFromDir(voicesDir: string): string[] {
  try {
    return readdirSync(voicesDir)
      .filter((f) => f.endsWith(".onnx"))
      .map((f) => f.slice(0, -".onnx".length))
      .sort();
  } catch {
    return [];
  }
}

/** Map raw runtime state onto the public status the UI/route consume. */
export function derivePiperStatus(raw: {
  available: boolean;
  serving: boolean;
  error: string | null;
  voices: string[];
  defaultVoice: string;
}): PiperStatus {
  return {
    available: raw.available,
    running: raw.available && raw.serving,
    error: raw.error,
    voices: raw.voices,
    defaultVoice: raw.defaultVoice,
  };
}

// ============================================================================
// Singleton process management
// ============================================================================

function ensureState(): PiperSingleton {
  if (!globalForPiper.__piperServer) {
    globalForPiper.__piperServer = {
      config: resolvePiperConfig(),
      child: null,
      serving: false,
      error: null,
      pollTimer: null,
    };
    process.once("exit", stopPiperServer);
  }
  return globalForPiper.__piperServer;
}

/** True when the piper HTTP server (not some other process on the port) is serving. */
async function isPiperReady(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/info`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function stopPoll(state: PiperSingleton): void {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function killChild(state: PiperSingleton): void {
  if (state.child) {
    try {
      state.child.kill();
    } catch {
      // already gone
    }
    state.child = null;
  }
  state.serving = false;
}

function spawnServer(state: PiperSingleton): void {
  stopPoll(state);
  killChild(state);
  state.error = null;
  state.serving = false;

  const child = spawn(state.config.python, buildPiperServerArgs(state.config), {
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err) => {
    state.error = `Failed to start piper server: ${err.message}`;
  });
  child.on("exit", () => {
    state.child = null;
    state.serving = false;
  });
  state.child = child;

  state.pollTimer = setInterval(() => {
    void isPiperReady(state.config.host, state.config.port).then((serving) => {
      if (serving) {
        state.serving = true;
        stopPoll(state);
      }
    });
  }, POLL_INTERVAL_MS);
}

function statusFrom(state: PiperSingleton, voices: string[]): PiperStatus {
  return derivePiperStatus({
    available: existsSync(state.config.python) && voices.length > 0,
    serving: state.serving,
    error: state.error,
    voices,
    defaultVoice: state.config.defaultVoice,
  });
}

/** Ensure the piper HTTP server is spawned (or adopted) and return status. */
export async function ensurePiperServer(): Promise<PiperStatus> {
  const state = ensureState();
  const voices = listVoicesFromDir(state.config.voicesDir);
  if (!existsSync(state.config.python) || voices.length === 0) {
    if (!state.error) state.error = "Piper not set up — run `npm run setup:voice`";
    return statusFrom(state, voices);
  }
  if (state.serving && state.child) return statusFrom(state, voices);
  if (await isPiperReady(state.config.host, state.config.port)) {
    state.serving = true;
    return statusFrom(state, voices);
  }
  spawnServer(state);
  return statusFrom(state, voices);
}

/** Current status without spawning. */
export function getPiperStatus(): PiperStatus {
  const state = ensureState();
  return statusFrom(state, listVoicesFromDir(state.config.voicesDir));
}

async function waitUntilServing(state: PiperSingleton, timeoutMs: number): Promise<void> {
  if (state.serving) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.serving || (await isPiperReady(state.config.host, state.config.port))) {
      state.serving = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new PiperError("Piper server is still warming up; try again in a moment");
}

/** Synthesize `text` into WAV bytes using `voice` (defaults to config default). */
export async function synthesizeSpeech(text: string, voice?: string): Promise<Uint8Array> {
  const status = await ensurePiperServer();
  if (!status.available) {
    throw new PiperError(status.error ?? "Piper TTS service is not available");
  }
  const state = ensureState();
  await waitUntilServing(state, SERVE_TIMEOUT_MS);

  const res = await fetch(`http://${state.config.host}:${state.config.port}${SYNTHESIZE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(voice ? { text, voice } : { text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PiperError(`Piper server returned ${res.status}${body ? `: ${body}` : ""}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Kill the child process (used on shutdown). */
export function stopPiperServer(): void {
  const state = globalForPiper.__piperServer;
  if (!state) return;
  stopPoll(state);
  killChild(state);
}
