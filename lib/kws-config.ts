/**
 * Keyword-spotting (wake word) configuration — resolves the Python interpreter
 * (which must have the `pocketsphinx` package) and the helper script path.
 * Reuses the piper venv, which `scripts/setup-voice.mjs` provisions with both
 * `piper-tts` and `pocketsphinx`.
 */

import { join } from "node:path";
import { resolvePiperConfig } from "./piper-config";

export interface KwsConfig {
  /** Python interpreter with `pocketsphinx` installed. */
  python: string;
  /** Path to `scripts/kws-helper.py`. */
  helper: string;
}

export function resolveKwsConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
): KwsConfig {
  const piper = resolvePiperConfig(env, baseDir);
  return {
    python: env.KWS_PYTHON || piper.python,
    helper: env.KWS_HELPER || join(baseDir, "scripts", "kws-helper.py"),
  };
}
