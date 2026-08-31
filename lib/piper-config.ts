/**
 * Piper TTS configuration — resolves the venv Python executable, the HTTP
 * server bind address, the voices directory, and the default voice.
 *
 * Design: pure path resolution, no filesystem I/O. The runtime (lib/piper-tts.ts)
 * spawns `python -m piper.http_server`; `scripts/setup-voice.mjs` creates the
 * venv and downloads voices. Priority: explicit env overrides, then the
 * repo-local `piper/` directory.
 */

import { join } from "node:path";

export interface PiperConfig {
  /** Path to the venv Python executable that has piper-tts + flask installed. */
  python: string;
  /** Bind host for the piper HTTP server. */
  host: string;
  /** Bind port for the piper HTTP server. */
  port: number;
  /** Directory containing downloaded `<voice>.onnx` + `<voice>.onnx.json`. */
  voicesDir: string;
  /** Voice name used when none is specified (the `-m` arg at spawn). */
  defaultVoice: string;
}

const DEFAULT_PORT = 8766;
const DEFAULT_VOICE = "en_US-lessac-medium";

export function resolvePiperConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
  platform: string = process.platform,
): PiperConfig {
  const isWin = platform === "win32";
  const repoDir = join(baseDir, "piper");
  const venvDir = env.PIPER_VENV_DIR || join(repoDir, "venv");
  const python = env.PIPER_PYTHON || join(venvDir, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const voicesDir = env.PIPER_VOICES_DIR || join(repoDir, "voices");
  const host = env.PIPER_HOST || "127.0.0.1";
  const portRaw = Number.parseInt(env.PIPER_PORT ?? "", 10);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_PORT;
  const defaultVoice = env.PIPER_DEFAULT_VOICE || DEFAULT_VOICE;
  return { python, host, port, voicesDir, defaultVoice };
}
