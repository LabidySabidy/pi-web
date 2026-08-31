/**
 * Whisper dictation bridge — spawns and talks to whisper.cpp's `whisper-server`
 * binary (from the Whisper VTT project) so the browser can transcribe mic audio
 * entirely offline.
 *
 * Server-only module: imports `node:*` and the pi SDK. Only imported by API
 * route handlers and `instrumentation.ts` — never by client components.
 */

import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface WhisperModel {
  name: string;
  path: string;
  bytes: number;
}

export interface WhisperConfig {
  rootDir: string;
  serverPath: string;
  modelDir: string;
  host: string;
  port: number;
  defaultModel: string;
}

export interface WhisperStatus {
  available: boolean;
  running: boolean;
  warmingUp: boolean;
  error: string | null;
  models: WhisperModel[];
  currentModel: string | null;
}

export interface RawWhisperState {
  serverExists: boolean;
  models: WhisperModel[];
  currentModel: string | null;
  spawned: boolean;
  serving: boolean;
  error: string | null;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_MODEL = "ggml-base.en.bin";
const INFERENCE_PATH = "/inference";
const POLL_INTERVAL_MS = 500;
const SERVE_TIMEOUT_MS = 60_000;

/**
 * Resolve the whisper-server binary + model dir. Priority: explicit env
 * overrides, then the repo-local `whisper/` dir (populated by
 * `scripts/setup-whisper.mjs`), then a `WHISPER_VTT_ROOT` override.
 */
export function resolveWhisperConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
  platform: string = process.platform,
): WhisperConfig {
  const isWin = platform === "win32";
  const repoDir = join(baseDir, "whisper");
  const explicitRoot = env.WHISPER_VTT_ROOT;

  const serverPath =
    env.WHISPER_SERVER_PATH ||
    (explicitRoot
      ? join(explicitRoot, "whisper-cli", "Release", "whisper-server.exe")
      : join(repoDir, "bin", isWin ? "whisper-server.exe" : "whisper-server"));
  const modelDir =
    env.WHISPER_MODEL_DIR || (explicitRoot ? join(explicitRoot, "models") : join(repoDir, "models"));

  const host = env.WHISPER_HOST || DEFAULT_HOST;
  const portRaw = Number.parseInt(env.WHISPER_PORT ?? "", 10);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_PORT;
  return { rootDir: explicitRoot || repoDir, serverPath, modelDir, host, port, defaultModel: DEFAULT_MODEL };
}

/** List loadable whisper.cpp models (ggml `*.bin` / `*.gguf`) in a directory. */
export function listWhisperModels(modelDir: string): WhisperModel[] {
  let entries: string[];
  try {
    entries = readdirSync(modelDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^ggml-.*\.bin$/.test(name) || name.endsWith(".gguf"))
    .map((name) => {
      const fullPath = join(modelDir, name);
      let bytes = 0;
      try {
        bytes = statSync(fullPath).size;
      } catch {
        // keep 0
      }
      return { name, path: fullPath, bytes };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Validate a requested model name against the discovered list. Empty/absent = no explicit choice. */
export function resolveModelChoice(
  requested: unknown,
  models: WhisperModel[],
): { model?: WhisperModel; error?: string } {
  if (requested === null || requested === undefined || requested === "") {
    return {};
  }
  if (typeof requested !== "string") {
    return { error: "Invalid model: expected a string" };
  }
  const model = models.find((m) => m.name === requested);
  if (!model) {
    return { error: `Unknown model: ${requested}` };
  }
  return { model };
}

/** Build a multipart/form-data body for a single file part (matches `curl -F file=@...`). */
export function buildMultipartFormData(
  boundary: string,
  filename: string,
  contentType: string,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prelude = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const out = new Uint8Array(prelude.length + data.length + epilogue.length);
  out.set(prelude, 0);
  out.set(data, prelude.length);
  out.set(epilogue, prelude.length + data.length);
  return out;
}

/** Map raw process/config state onto the public status the UI consumes. */
export function deriveWhisperStatus(raw: RawWhisperState): WhisperStatus {
  const available = raw.serverExists && raw.models.length > 0;
  return {
    available,
    running: available && raw.spawned && raw.serving,
    warmingUp: available && raw.spawned && !raw.serving,
    error: raw.error,
    models: raw.models,
    currentModel: raw.currentModel,
  };
}

// ── Model preference persistence (~/.pi/agent/whisper-vtt.json) ────────────

type StoredWhisperPrefs = Record<string, unknown> & { model?: unknown };

export function getWhisperPrefsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "whisper-vtt.json");
}

function readStoredPrefs(prefsPath: string): StoredWhisperPrefs {
  if (!existsSync(prefsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as StoredWhisperPrefs;
  } catch {
    return {};
  }
}

export function readWhisperModelPref(prefsPath: string = getWhisperPrefsPath()): string | null {
  const stored = readStoredPrefs(prefsPath);
  return typeof stored.model === "string" && stored.model ? stored.model : null;
}

export function writeWhisperModelPref(model: string, prefsPath: string = getWhisperPrefsPath()): void {
  const stored = readStoredPrefs(prefsPath);
  mkdirSync(dirname(prefsPath), { recursive: true });
  writePrivateFileAtomicSync(prefsPath, JSON.stringify({ ...stored, model }, null, 2));
}

// ── Singleton process management (survives Next.js HMR via globalThis) ──────

interface WhisperSingleton {
  config: WhisperConfig;
  child: ChildProcess | null;
  currentModel: string | null;
  serving: boolean;
  error: string | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

const globalForWhisper = globalThis as unknown as { __whisperServer?: WhisperSingleton };

export class WhisperError extends Error {}

function ensureState(): WhisperSingleton {
  if (!globalForWhisper.__whisperServer) {
    globalForWhisper.__whisperServer = {
      config: resolveWhisperConfig(),
      child: null,
      currentModel: null,
      serving: false,
      error: null,
      pollTimer: null,
    };
    process.once("exit", stopWhisperServer);
  }
  return globalForWhisper.__whisperServer;
}

function isPortServing(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function stopPoll(state: WhisperSingleton): void {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function killChild(state: WhisperSingleton): void {
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

function pickModel(state: WhisperSingleton, models: WhisperModel[]): WhisperModel {
  const pref = readWhisperModelPref();
  if (pref) {
    const found = models.find((m) => m.name === pref);
    if (found) return found;
  }
  return models.find((m) => m.name === state.config.defaultModel) ?? models[0];
}

function spawnServer(state: WhisperSingleton, model: WhisperModel): void {
  stopPoll(state);
  killChild(state);
  state.error = null;
  state.serving = false;
  state.currentModel = model.name;

  const child = spawn(
    state.config.serverPath,
    ["-m", model.path, "--host", state.config.host, "--port", String(state.config.port)],
    { stdio: "ignore", windowsHide: true },
  );
  child.on("error", (err) => {
    state.error = `Failed to start whisper server: ${err.message}`;
  });
  child.on("exit", () => {
    state.child = null;
    state.serving = false;
  });
  state.child = child;

  state.pollTimer = setInterval(() => {
    void isPortServing(state.config.host, state.config.port).then((serving) => {
      if (serving) {
        state.serving = true;
        stopPoll(state);
      }
    });
  }, POLL_INTERVAL_MS);
}

function statusFrom(state: WhisperSingleton, models: WhisperModel[]): WhisperStatus {
  return deriveWhisperStatus({
    serverExists: existsSync(state.config.serverPath),
    models,
    currentModel: state.currentModel,
    spawned: !!state.child,
    serving: state.serving,
    error: state.error,
  });
}

/** Ensure the whisper server is spawned (or adopted) and return current status. */
export async function ensureWhisperServer(): Promise<WhisperStatus> {
  const state = ensureState();
  const models = listWhisperModels(state.config.modelDir);
  if (!existsSync(state.config.serverPath) || models.length === 0) {
    if (!state.error) state.error = "Whisper server not found or no local models";
    return statusFrom(state, models);
  }
  if (state.serving && state.child) return statusFrom(state, models);
  if (await isPortServing(state.config.host, state.config.port)) {
    state.serving = true;
    return statusFrom(state, models);
  }
  const model = pickModel(state, models);
  if (!state.child || state.currentModel !== model.name) {
    spawnServer(state, model);
  }
  return statusFrom(state, models);
}

/** Current status without spawning. */
export function getWhisperStatus(): WhisperStatus {
  const state = ensureState();
  const models = listWhisperModels(state.config.modelDir);
  return statusFrom(state, models);
}

/** Persist the chosen model and restart the server on it. */
export async function switchWhisperModel(requested: unknown): Promise<WhisperStatus> {
  const state = ensureState();
  const models = listWhisperModels(state.config.modelDir);
  const { model, error } = resolveModelChoice(requested, models);
  if (error || !model) {
    throw new WhisperError(error ?? "Invalid model");
  }
  writeWhisperModelPref(model.name);
  spawnServer(state, model);
  return statusFrom(state, models);
}

async function waitUntilServing(state: WhisperSingleton, timeoutMs: number): Promise<void> {
  if (state.serving) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.serving || (await isPortServing(state.config.host, state.config.port))) {
      state.serving = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new WhisperError("Whisper server is still warming up; try again in a moment");
}

/** Transcribe a WAV buffer (16kHz mono PCM) and return the trimmed text. */
export async function transcribeWav(wav: Uint8Array): Promise<string> {
  const status = await ensureWhisperServer();
  if (!status.available) {
    throw new WhisperError("Whisper dictation service is not available");
  }
  const state = ensureState();
  await waitUntilServing(state, SERVE_TIMEOUT_MS);

  const boundary = `----piweb-${randomUUID()}`;
  const body = buildMultipartFormData(boundary, "audio.wav", "audio/wav", wav);
  const res = await fetch(`http://${state.config.host}:${state.config.port}${INFERENCE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new WhisperError(`Whisper server returned ${res.status}${body ? `: ${body}` : ""}`);
  }
  const data = (await res.json()) as { text?: string };
  return cleanTranscription(data.text ?? "");
}

/** Strip whisper no-speech markers so silence doesn't insert a literal token. */
export function cleanTranscription(text: string): string {
  return text
    .replace(/\[BLANK_AUDIO\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kill the child process (used on shutdown and by tests). */
export function stopWhisperServer(): void {
  const state = globalForWhisper.__whisperServer;
  if (!state) return;
  stopPoll(state);
  killChild(state);
}
