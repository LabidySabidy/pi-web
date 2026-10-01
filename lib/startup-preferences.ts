import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

export interface PersistStartupResult {
  modelDefaultChanged: boolean;
  /**
   * True when a thinking level WAS requested but the session did not resolve to it, so nothing was
   * written. Informational: the caller may surface it, and it is what makes the refusal observable
   * rather than silent.
   */
  thinkingLevelDiverged?: boolean;
}

/**
 * Persist explicit browser selections without re-running AgentSession setters.
 *
 * The session constructor already records the effective model and thinking
 * level. Calling setModel()/setThinkingLevel() again would append duplicate
 * session entries and emit duplicate extension events.
 *
 * THINKING LEVEL: PERSIST WHAT THE GUARD ASKED ABOUT, NOT WHAT THE SESSION CURRENTLY SAYS.
 *
 * This function asks one question — "did the caller choose this?" — and the answer decides whether
 * anything is written to the GLOBAL settings file. The value written must therefore be the one the
 * question was about. It used to be `effective.thinkingLevel`, which is the session's LIVE level,
 * and the two can diverge: `setThinkingLevel` is called by model switches and level cycling with no
 * user action (`agent-session.js:1215/1254/1277/1321`), and an extension may move the level on
 * purpose — the harness's `reasoning-level` extension does exactly that for read sweeps. So a
 * transient level could be persisted as the user's global default, and every later session would
 * start there. See the harness's LESSONS.md GL-033.
 *
 * WHY DIVERGENCE PERSISTS NOTHING, rather than picking a side. Two situations produce a mismatch and
 * they are INDISTINGUISHABLE from inside this function: construction CLAMPED an unrepresentable
 * request (the `xhigh`-requested / `high`-resolved case the tests cover), or something moved the
 * level after construction. Persisting the resolved value is right for the first and wrong for the
 * second, which is the bug; persisting the requested value is right for the second and can store a
 * level the model cannot represent. Refusing is the only option that is not wrong in one of the two
 * cases, and a refusal is recoverable where a wrong default is not.
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<PersistStartupResult> {
  if (!explicit.model && !explicit.thinkingLevel) {
    return { modelDefaultChanged: false };
  }

  let modelDefaultChanged = false;
  let thinkingLevelDiverged = false;

  if (
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId
  ) {
    settingsManager.setDefaultModelAndProvider(
      effective.model.provider,
      effective.model.modelId,
    );
    modelDefaultChanged = true;
  }

  if (explicit.thinkingLevel) {
    if (effective.thinkingLevel !== explicit.thinkingLevel) {
      // The request is not what the session ended up with. Do not guess which one the user meant.
      thinkingLevelDiverged = true;
    } else if (effective.supportsThinking || effective.thinkingLevel !== "off") {
      settingsManager.setDefaultThinkingLevel(explicit.thinkingLevel);
    }
  }

  await settingsManager.flush();
  return thinkingLevelDiverged
    ? { modelDefaultChanged, thinkingLevelDiverged: true }
    : { modelDefaultChanged };
}
