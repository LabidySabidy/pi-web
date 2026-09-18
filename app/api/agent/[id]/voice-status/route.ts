import { NextResponse } from "next/server";
import { getPiperStatus, synthesizeSpeech, PiperError } from "@/lib/piper-tts";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import { summariseStatus } from "@/lib/live-status";
import { buildStatusSnapshot, type StatusSessionLike } from "@/lib/live-status-source";

export const dynamic = "force-dynamic";

/**
 * Spoken status for Live Conversation mode.
 *
 *   GET /api/agent/[id]/voice-status            → { text }  (testable, silent)
 *   GET /api/agent/[id]/voice-status?speak=1    → audio/wav
 *
 * Answers "how's it going?" from live state. **Nothing is appended to the
 * session and no agent turn is started** -- that is the whole point, since the
 * user is asking *instead of* interrupting.
 *
 * Synthesis goes straight to Piper, deliberately skipping the summarization
 * step that `/api/speak` performs. A status report is already written for
 * speech -- `live-status.ts` bounds its length and strips code and markdown --
 * so summarizing it again would add a measured ~930ms to the critical path of a
 * query whose entire value is being fast, in exchange for re-wording text that
 * has nothing to compress. Measured on this machine: Piper alone 506ms vs
 * summarize+Piper 1440ms, with near-identical output size (~217KB both).
 *
 * The `text` form exists so the spoken sentence can be asserted without paying
 * for synthesis.
 */

/** Belt-and-braces guard so a future change cannot send a wall of text to TTS. */
const MAX_STATUS_WORDS = 60;

/** The subset of the wrapper's get_state payload this route consumes. */
interface RpcStateLike {
  isStreaming?: unknown;
  isPromptRunning?: unknown;
  isBashRunning?: unknown;
  isCompacting?: unknown;
  contextUsage?: unknown;
  queuedMessages?: {
    steering?: unknown;
    followUp?: unknown;
  };
}

function asCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Adapt an `AgentSessionWrapper` into the shape `buildStatusSnapshot` wants. */
export function sessionLikeFromState(state: RpcStateLike): StatusSessionLike {
  const contextUsage = state.contextUsage as { percent?: unknown } | null | undefined;
  const percent = contextUsage && typeof contextUsage.percent === "number" ? contextUsage.percent : null;

  return {
    isStreaming: Boolean(state.isStreaming),
    pendingMessageCount: state.isPromptRunning ? 1 : 0,
    isBashRunning: Boolean(state.isBashRunning),
    isCompacting: Boolean(state.isCompacting),
    getContextUsage: () => (percent === null ? null : { percent }),
    getSteeringMessages: () => [],
    // Counts are already summarised by get_state, so they are attached directly
    // below rather than faked through accessors.
  };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  const session = getRpcSession(id);

  // Read state through the wrapper's public RPC surface rather than reaching
  // into `inner`, so this cannot drift from what the UI itself sees.
  let state: RpcStateLike = {};
  if (session?.isAlive()) {
    try {
      state = ((await session.send({ type: "get_state" })) ?? {}) as RpcStateLike;
    } catch {
      // A status reply must survive a session that is mid-replacement or
      // otherwise busy: fall through to the idle report rather than 500ing.
      state = {};
    }
  }

  const queued = state.queuedMessages;
  const snapshot = {
    ...buildStatusSnapshot({
      session: sessionLikeFromState(state),
      sessions: getRpcSessionInfos(),
      sessionId: id,
    }),
    steeringCount: asCount(queued?.steering),
    followUpCount: asCount(queued?.followUp),
  };

  const text = summariseStatus(snapshot);
  const url = new URL(req.url);

  if (url.searchParams.get("speak") !== "1") {
    return NextResponse.json({ text, snapshot });
  }

  if (wordCount(text) > MAX_STATUS_WORDS) {
    return NextResponse.json(
      { error: `status report too long to speak (${wordCount(text)} words)`, text },
      { status: 500 },
    );
  }

  const voice = url.searchParams.get("voice")?.trim() || undefined;
  try {
    const wav = await synthesizeSpeech(text, voice);
    return new NextResponse(wav as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const status = error instanceof PiperError ? 503 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Speech synthesis failed", text },
      { status },
    );
  }
}

/** Voices for the status player, mirroring /api/speak/voices. */
export async function OPTIONS(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const status = getPiperStatus();
  return NextResponse.json({
    voices: status.voices,
    defaultVoice: status.defaultVoice,
    available: status.available,
  });
}
