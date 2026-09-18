/**
 * Voice intent router for Live Conversation mode.
 *
 * Every utterance from the mic is text. This module answers one question:
 * **given that a turn may already be running, what should happen to it?**
 *
 *   status     -> answer from live state; NOTHING is appended to the session
 *   abort      -> stop the running turn
 *   steer      -> inject between steps; the run continues
 *   follow_up  -> queue for after the run finishes
 *   prompt     -> a normal new turn
 *
 * Two properties drive the design.
 *
 * 1. **`prompt` is illegal while streaming.** lib/rpc-manager.ts rejects a bare
 *    prompt during a run; the caller must pass `streamingBehavior`. That is why
 *    classification depends on `isStreaming` and cannot be stateless.
 *
 * 2. **Misclassification is asymmetric.** `stop` read as `steer` is harmless --
 *    the agent gets a sentence it ignores. But "also update the docs" read as
 *    `abort` KILLS A RUNNING TASK. So `abort` demands strong evidence and
 *    degrades to `steer` when it is missing; every other low-confidence case
 *    falls back to a non-destructive label.
 *
 * The pure decision logic lives in `decideIntent` / `classifyLocally` so it can
 * be tested exhaustively without a model or a network call.
 */

export type VoiceIntent = "status" | "abort" | "steer" | "follow_up" | "prompt";

export interface VoiceIntentResult {
  intent: VoiceIntent;
  /** 0..1. Only meaningful for model-derived classification; 1 for a fast-path hit. */
  confidence: number;
  /** Where the decision came from -- surfaced so the UI can show why it acted. */
  source: "fast-path" | "model" | "fallback";
  /** Present when the model returned unusable output, for logging. */
  reason?: string;
}

export interface VoiceContext {
  /** Whether a turn is currently streaming. Required: see property 1 above. */
  isStreaming: boolean;
  /** Age of the running turn in ms, when one is running. */
  turnAgeMs?: number;
  /** Latest assistant text, when available, for context. */
  lastAssistantText?: string;
}

/** Below this, `abort` is downgraded to `steer` (see property 2). */
export const ABORT_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Utterances that are unambiguously an instruction to stop. Matched as a whole
 * phrase (after normalisation) so that "don't stop the build" is not caught.
 * These bypass the model entirely -- the common case costs zero latency.
 */
const ABORT_PHRASES = new Set([
  "stop",
  "stop it",
  "stop please",
  "wait",
  "wait wait",
  "hold on",
  "hold up",
  "hang on",
  "cancel",
  "cancel that",
  "abort",
  "never mind",
  "nevermind",
  "forget it",
  "forget that",
  "stop everything",
  "halt",
  "pause",
  "pause it",
  "quit it",
  "shut up",
  "enough",
  "that's enough",
  "thats enough",
  "ok stop",
  "okay stop",
  "no stop",
]);

/**
 * Question-shaped utterances that ask about progress rather than instructing.
 * These are ANSWERED, never dispatched -- the property that makes the
 * "middleman" useful without polluting the conversation.
 */
const STATUS_PATTERNS: RegExp[] = [
  /\bhow('?s| is| are)\b.*\b(going|doing|it coming|the (run|task|job|work))\b/,
  /\bwhat('?s| is| are)\b.*\b(working on|doing|happening|the status|your status|the progress)\b/,
  /\b(any|what)\b.*\b(progress|update|updates|news)\b/,
  /\bstatus\b/,
  /\bwhere (are|were) (you|we)\b/,
  /\bare you (done|finished|still|there|busy|working)\b/,
  /\bhow (long|much longer|far along)\b/,
  /\bwhat (have|had) you (done|finished) (so far|yet)\b/,
  /\bwhere are you at\b/,
  /\btalk to me\b/,
  /\bgive me (an|a) update\b/,
];

/**
 * Phrases that push work to *after* the current run rather than into it.
 * Checked before `steer` because "after you're done, also do X" contains both
 * cues and the weaker one must not win.
 */
const FOLLOW_UP_PATTERNS: RegExp[] = [
  /\b(when|after|once)\b.*\b(done|finish|finished|complete|completed|through|wrapped)\b/,
  /\bafter (that|this|you)\b/,
  /\bwhen you('re| are) (done|finished)\b/,
  /\b(when|if) (you get|you've got|you have) a (chance|moment|sec|minute)\b/,
  /\bfollow[- ]?up\b/,
  /\blater\b/,
  /\bafterwards?\b/,
  /\bnext (time|up)\b/,
];

/** Phrases signalling a change to work already in flight. */
const STEER_PATTERNS: RegExp[] = [
  /\b(also|and also|plus|additionally)\b/,
  /\b(instead|rather|actually)\b/,
  /\b(skip|don't|dont|ignore|drop|leave out|forget about)\b/,
  /\b(use|try|prefer|go with|switch to|stick with)\b/,
  /\b(change|adjust|tweak|modify|undo|revert|back out)\b/,
  /\bmake sure\b/,
  /\bremember to\b/,
  /\bwait[, ]+(no|actually|use|do)\b/,
  /\bwhat about\b/,
  /\bcan you (also|instead)\b/,
  /\b(not|stop) (that|the)\b.*\b(do|use|try)\b/,
];

/**
 * Strip punctuation and collapse whitespace, lowercase. Question marks are kept
 * (dropped punctuation would erase the interrogative signal the status patterns
 * rely on), but a string of nothing but punctuation normalises to empty so it is
 * never mistaken for an instruction.
 */
export function normaliseTranscript(text: string): string {
  const stripped = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "???" carries no instruction; treat it as silence.
  if (!/[\p{L}\p{N}]/u.test(stripped)) return "";
  return stripped;
}

function matchesAny(patterns: RegExp[], haystack: string): boolean {
  return patterns.some((re) => re.test(haystack));
}

/**
 * Decide without a model. Returns null when the fast path cannot rule, in which
 * case the caller escalates to the LLM.
 *
 * Order matters: abort phrases are matched on the *whole* utterance (exact), so
 * "don't stop the build" cannot trip it; then status, then follow-up, then
 * steer -- the weaker cue must never win.
 *
 * **Cue priority is not the same as confidence priority.** A steer cue is weak
 * evidence: "also check the tests" is a steer, but "don't stop" contains the
 * same shape and means abort. So whenever an abort-ish or completion-ish word
 * appears anywhere in the utterance, the fast path declines and lets the model
 * rule -- the cost is one classifier call, and the alternative is guessing on
 * the one label that destroys work.
 */
export function classifyLocally(
  transcript: string,
  context: VoiceContext,
): VoiceIntentResult | null {
  const norm = normaliseTranscript(transcript);
  if (!norm) return null;

  // Exact-phrase stop words only: a short utterance that is entirely one of
  // these. "stop the build" is NOT here -- that is a steer.
  const bare = norm.replace(/\?+$/, "").trim();
  if (ABORT_PHRASES.has(norm) || ABORT_PHRASES.has(bare)) {
    return { intent: "abort", confidence: 1, source: "fast-path" };
  }

  // A question about progress is answered, never dispatched. Safe while idle
  // and while streaming.
  if (matchesAny(STATUS_PATTERNS, norm)) {
    return { intent: "status", confidence: 1, source: "fast-path" };
  }

  // Escalate to the model when the utterance mixes cues that could mean either
  // cessation or continuation. Guessing here is what turns "don't stop the
  // build" into a killed run.
  if (/\.?\b(don't|dont|do not)\b/.test(norm) && AMBIGUOUS_WORDS.test(norm)) {
    return null;
  }

  // Queueing cues are only meaningful when something is running; while idle a
  // "when you're done" is just a normal request.
  if (context.isStreaming && matchesAny(FOLLOW_UP_PATTERNS, norm)) {
    return { intent: "follow_up", confidence: 1, source: "fast-path" };
  }

  // Nothing to steer while idle.
  if (context.isStreaming && matchesAny(STEER_PATTERNS, norm)) {
    return { intent: "steer", confidence: 1, source: "fast-path" };
  }

  return null;
}

/** Words whose polarity a negation can flip. Used only to decide when to escalate. */
const AMBIGUOUS_WORDS = /\b(stop|cancel|skip|abort|halt|drop|quit|pause|wait|revert|undo)\b/;

export interface DecideInput {
  transcript: string;
  context: VoiceContext;
  modelResult?: { intent: VoiceIntent; confidence: number } | null;
  modelError?: string;
}

export const VALID_INTENTS: readonly VoiceIntent[] = [
  "status",
  "abort",
  "steer",
  "follow_up",
  "prompt",
];

export function isVoiceIntent(value: unknown): value is VoiceIntent {
  return typeof value === "string" && (VALID_INTENTS as readonly string[]).includes(value);
}

/**
 * Final decision, with the safety downgrades. Pure -- the model call happens
 * outside so this stays exhaustively testable.
 */
export function decideIntent(input: DecideInput): VoiceIntentResult {
  const { transcript, context, modelResult, modelError } = input;

  const local = classifyLocally(transcript, context);
  if (local) return local;

  if (!modelResult || modelError) {
    // The model is unusable. Fall back to the least destructive action, which
    // depends on whether a run is in flight: queueing can never kill work,
    // whereas a bare prompt is both unsafe and (while streaming) illegal.
    return {
      intent: context.isStreaming ? "follow_up" : "prompt",
      confidence: 0,
      source: "fallback",
      ...(modelError ? { reason: modelError } : {}),
    };
  }

  const { intent } = modelResult;
  const confidence = clamp01(modelResult.confidence);

  // Nothing is running, so nothing can be aborted. Handle this BEFORE the
  // confidence check: a *confident* abort while idle is still a no-op, and
  // dispatching it would report a cancellation that never happened.
  if (intent === "abort" && !context.isStreaming) {
    return { intent: "prompt", confidence, source: "model", reason: "abort-without-run" };
  }

  // Property 2: `abort` is the only destructive label, so it needs strong
  // evidence. Below the bar we degrade to `steer`, which cannot kill a run.
  if (intent === "abort" && confidence < ABORT_CONFIDENCE_THRESHOLD) {
    return {
      intent: "steer",
      confidence,
      source: "model",
      reason: "abort-below-threshold",
    };
  }

  // Steering and queueing require a run to act on. While idle they are just
  // requests, and the user meant a new turn.
  if ((intent === "steer" || intent === "follow_up") && !context.isStreaming) {
    return { intent: "prompt", confidence, source: "model", reason: "no-run" };
  }

  return { intent, confidence, source: "model" };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Build the classification prompt. Kept tiny and single-word-output so the call
 * adds as little latency as possible; the caller caps maxTokens.
 */
export function buildClassifyPrompt(transcript: string, context: VoiceContext): string {
  const state = context.isStreaming
    ? `A task is CURRENTLY RUNNING${
        typeof context.turnAgeMs === "number" ? ` (started ${Math.round(context.turnAgeMs / 1000)}s ago)` : ""
      }.`
    : "The assistant is IDLE; no task is running.";

  const recent = context.lastAssistantText?.trim()
    ? `\nMost recent assistant text:\n"""\n${context.lastAssistantText.slice(0, 800)}\n"""`
    : "";

  return [
    "Classify the user's spoken utterance into exactly one label.",
    "",
    state + recent,
    "",
    "Labels:",
    "- status: asks about progress. No instruction. (e.g. \"how's it going\", \"what are you working on\")",
    "- abort: tells the assistant to stop the running task. (e.g. \"stop\", \"hold on\", \"cancel that\")",
    "- steer: changes or adds to the work IN FLIGHT, which should continue. (e.g. \"also check the tests\", \"skip the docs\")",
    "- follow_up: work to do AFTER the current task finishes. (e.g. \"when you're done, update the README\")",
    "- prompt: a new request, or anything else.",
    "",
    "Rules:",
    "- Answering questions is not an instruction; prefer status.",
    "- A question that also asks for work is steer or follow_up, not status.",
    "- Prefer steer or prompt over abort unless the user clearly wants the task stopped.",
    "",
    "Utterance:",
    `"""${transcript}"""`,
    "",
    'Reply with JSON only: {"intent":"<label>","confidence":<0..1>}',
  ].join("\n");
}

/** Parse the model's reply. Returns null when unusable, so the caller can fall back. */
export function parseClassifyResponse(
  raw: string,
): { intent: VoiceIntent; confidence: number } | null {
  if (!raw) return null;
  // Tolerate prose, code fences, and a stray leading label by extracting the
  // first JSON object rather than requiring the body to be pure JSON.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!isVoiceIntent(record.intent)) return null;
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? clamp01(record.confidence)
      : 0.5;
  return { intent: record.intent, confidence };
}
