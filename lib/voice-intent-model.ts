/**
 * Model-backed voice intent classification.
 *
 * Wraps the pure decision logic in `voice-intent.ts` with a single small-model
 * call. Kept in its own module so the safety rules stay testable without a
 * model, network, or credentials.
 *
 * The call is deliberately cheap: one short prompt, a capped reply, and a low
 * temperature. Classification is the last hop before dispatch, so its latency
 * lands directly on perceived response time -- the local fast path in
 * `classifyLocally` exists precisely so the common utterances never reach here.
 */

import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  buildClassifyPrompt,
  classifyLocally,
  decideIntent,
  parseClassifyResponse,
  type VoiceContext,
  type VoiceIntentResult,
} from "./voice-intent";

// Flash tier on purpose: this is a one-word classification, not reasoning.
const CLASSIFIER_PROVIDER = "deepseek";
const CLASSIFIER_MODEL = "deepseek-v4-flash";

/** Generous for a single JSON object; tight enough to bound worst-case latency. */
const MAX_REPLY_TOKENS = 40;
const CLASSIFY_TIMEOUT_MS = 4_000;

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface ClassifyVoiceIntentOptions {
  /** Injected for tests; defaults to the real model call. */
  classify?: (transcript: string, context: VoiceContext) => Promise<string>;
}

/**
 * Classify an utterance and apply the safety downgrades.
 *
 * Never throws: any failure (no credentials, timeout, unparseable reply) is
 * reported through the result's `source: "fallback"` and `reason`, because a
 * voice turn must not die when the classifier does. The fallback is chosen to be
 * both non-destructive and legal -- see `decideIntent`.
 */
export async function classifyVoiceIntent(
  transcript: string,
  context: VoiceContext,
  options: ClassifyVoiceIntentOptions = {},
): Promise<VoiceIntentResult> {
  const callModel = options.classify ?? defaultClassify;

  let raw: string | null = null;
  let modelError: string | undefined;

  // Skip the call entirely when the local fast path can already decide with
  // certainty. decideIntent() consults the same fast path, so this only avoids
  // paying for a call whose answer would be discarded.
  if (classifyLocally(transcript, context)) {
    return decideIntent({ transcript, context });
  }

  try {
    raw = await callModel(transcript, context);
  } catch (error) {
    modelError = error instanceof Error ? error.message : String(error);
  }

  const modelResult = raw ? parseClassifyResponse(raw) : null;
  return decideIntent({ transcript, context, modelResult, modelError });
}

async function defaultClassify(transcript: string, context: VoiceContext): Promise<string> {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(CLASSIFIER_PROVIDER, CLASSIFIER_MODEL);
  if (!model) {
    throw new Error(`Classifier model not found: ${CLASSIFIER_PROVIDER}/${CLASSIFIER_MODEL}`);
  }
  const resolved = await modelRuntime.getAuth(model);
  if (!resolved?.auth.apiKey) {
    throw new Error(`No API key configured for "${CLASSIFIER_PROVIDER}"`);
  }

  const message = await completeSimple(
    model,
    {
      messages: [
        { role: "user", content: buildClassifyPrompt(transcript, context), timestamp: Date.now() },
      ],
    },
    {
      apiKey: resolved.auth.apiKey,
      headers: resolved.auth.headers,
      maxTokens: MAX_REPLY_TOKENS,
      timeoutMs: CLASSIFY_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
    },
  );

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? "Intent classification failed");
  }
  return assistantText(message);
}
