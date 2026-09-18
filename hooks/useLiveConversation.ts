"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveCapture } from "@/hooks/useLiveCapture";
import { useLivePlayer } from "@/hooks/useLivePlayer";
import { TurnLifecycle } from "@/lib/turn-lifecycle";
import { encodeWav } from "@/lib/audio";
import { routeIntent } from "@/lib/live-routing";
import type { VoiceIntent, VoiceIntentResult } from "@/lib/voice-intent";

/**
 * Live Conversation orchestrator.
 *
 * Wires the pieces together: capture → classify → dispatch, with playback gated
 * so the mic never hears its own voice, and a turn lifecycle so a barge-in
 * cannot leave the UI stuck on "thinking".
 *
 * The dispatch table is the heart of it:
 *
 *   status     answer from live state; NOTHING is appended to the session
 *   abort      stop the running turn
 *   steer      inject between steps; the run continues
 *   follow_up  queue for after the run completes
 *   prompt     a normal new turn
 *
 * A status query is answered without touching the agent, which is what lets the
 * user check in mid-task instead of interrupting.
 */

export type LivePhase =
  | "off"
  | "starting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "routing"
  | "thinking"
  | "speaking"
  | "error";

export interface LiveConversationOptions {
  sessionId: string | null | undefined;
  /** Read live so routing sees the current state, not a stale render value. */
  isStreaming: () => boolean;
  onPrompt: (text: string) => void;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
  voice?: string;
  /** Injected so this hook is testable without a model call. */
  classify: (
    text: string,
    context: { isStreaming: boolean; turnAgeMs?: number },
  ) => Promise<VoiceIntentResult>;
}

export interface LiveConversationState {
  active: boolean;
  phase: LivePhase;
  error: string | null;
  transcript: string | null;
  lastIntent: VoiceIntent | null;
  levelRef: { current: number };
  toggle: () => void;
  interrupt: () => void;
}

export function useLiveConversation(options: LiveConversationOptions): LiveConversationState {
  // All options are read through `optionsRef` below, so callbacks are stable and
  // never close over a stale render. Nothing is destructured here on purpose --
  // a destructured copy would be captured at first render.

  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<LivePhase>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [lastIntent, setLastIntent] = useState<VoiceIntent | null>(null);

  const turnRef = useRef(new TurnLifecycle());
  const turnStartedAtRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const activeRef = useRef(false);
  /**
   * Set below, once handleUtterance exists. capture's onUtterance is bound a
   * single time, so it reads through this ref rather than capturing a stale
   * closure -- and it is declared here so the reference is never in a temporal
   * dead zone.
   */
  const handleUtteranceRef = useRef<(u: { audio: Float32Array; sampleRate: number }) => void>(() => {});

  // Latest options without re-creating callbacks (and without stale closures).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const player = useLivePlayer({
    onStart: () => setPhase("speaking"),
    onEnd: () => setPhase((p) => (p === "speaking" ? "listening" : p)),
  });

  const capture = useLiveCapture({
    onUtterance: (u) => void handleUtteranceRef.current(u),
    onError: (message) => setError(message),
  });

  /** Idle phase implied by the capture state. */
  const idlePhase = useCallback(
    (): LivePhase => (capture.phase === "error" ? "error" : "listening"),
    [capture.phase],
  );

  /**
   * Half-duplex gate. AEC (echoCancellation "all") handles most self-audio, but
   * gating is what makes transcribing our own voice impossible rather than
   * merely unlikely.
   */
  const setGate = useCallback(
    (open: boolean) => {
      capture.setCaptureEnabled(open);
    },
    [capture],
  );

  /** Fetch WAV from a speech route and play it, gate closed throughout. */
  const speakUrl = useCallback(
    async (url: string) => {
      setGate(false);
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const wav = await res.arrayBuffer();
        if (wav.byteLength > 0) await player.play(wav);
      } catch {
        // Speech is a courtesy; a failed reply must not end the session.
      } finally {
        setGate(true);
      }
    },
    [player, setGate],
  );

  /** Dispatch a classified utterance. */
  const dispatch = useCallback(
    async (intent: VoiceIntent, text: string) => {
      const opts = optionsRef.current;

      if (intent === "status") {
        // Answered from live state: no prompt, no message appended. This is the
        // property that lets the user check in without interrupting. `status`
        // is handled here rather than through a callback because it has a side
        // effect (speaking) but no agent dispatch.
        if (!opts.sessionId) {
          setPhase(idlePhase());
          return;
        }
        const url = `/api/agent/${encodeURIComponent(opts.sessionId)}/voice-status?speak=1${
          opts.voice ? `&voice=${encodeURIComponent(opts.voice)}` : ""
        }`;
        await speakUrl(url);
        setPhase(idlePhase());
        return;
      }

      const route = routeIntent(intent, text);

      // The lifecycle is driven from the router's decision, so the "only prompt
      // begins, only abort cancels" rule lives in one tested place.
      if (route.lifecycle === "cancel") turnRef.current.cancel();
      else if (route.lifecycle === "begin") {
        turnRef.current.begin();
        turnStartedAtRef.current = Date.now();
      }

      switch (route.action) {
        case "onAbort":
          opts.onAbort();
          setPhase(idlePhase());
          return;
        case "onSteer":
          opts.onSteer(text);
          setPhase("thinking");
          return;
        case "onFollowUp":
          opts.onFollowUp(text);
          setPhase("thinking");
          return;
        case "onPrompt":
          opts.onPrompt(text);
          setPhase("thinking");
          // Re-assert so the new turn's events forward, decaying one stale end.
          turnRef.current.rearm();
          return;
        default:
          return;
      }
    },
    [idlePhase, speakUrl],
  );

  const handleUtterance = useCallback(
    async (utterance: { audio: Float32Array; sampleRate: number }) => {
      // One utterance at a time: a second arriving mid-flight would race the
      // classifier and could dispatch two turns for one sentence.
      if (busyRef.current) {
        turnRef.current.revert();
        return;
      }
      busyRef.current = true;
      setPhase("transcribing");

      try {
        let text = "";
        try {
          const wav = encodeWav(utterance.audio, utterance.sampleRate);
          const res = await fetch("/api/transcribe", { method: "POST", body: wav });
          if (!res.ok) return;
          text = ((await res.json()) as { text?: string }).text?.trim() ?? "";
        } catch {
          return;
        }

        if (!text) {
          turnRef.current.revert(); // nothing was said; undo the expectation
          return;
        }

        setTranscript(text);
        setPhase("routing");

        const streaming = optionsRef.current.isStreaming();
        const turnStartedAt = turnStartedAtRef.current;
        const decision = await optionsRef.current.classify(text, {
          isStreaming: streaming,
          ...(streaming && turnStartedAt ? { turnAgeMs: Date.now() - turnStartedAt } : {}),
        });
        setLastIntent(decision.intent);
        await dispatch(decision.intent, text);
      } finally {
        busyRef.current = false;
        setPhase((p) => (p === "thinking" || p === "speaking" ? p : idlePhase()));
      }
    },
    [dispatch, idlePhase],
  );

  handleUtteranceRef.current = handleUtterance;

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    turnRef.current.reset();
    await capture.start();
    activeRef.current = true;
    setActive(true);
    setPhase(capture.phase === "error" ? "error" : "listening");
  }, [capture]);

  const stopAll = useCallback(() => {
    player.stop();
    capture.stop();
    turnRef.current.reset();
    turnStartedAtRef.current = null;
    activeRef.current = false;
    setActive(false);
    setPhase("off");
  }, [capture, player]);

  const toggle = useCallback(() => {
    if (activeRef.current) stopAll();
    else void start();
  }, [start, stopAll]);

  const interrupt = useCallback(() => {
    // Cut off speech and take the floor. Cancelling the lifecycle means the
    // interrupted turn's late events are suppressed, not replayed.
    player.stop();
    turnRef.current.cancel();
    setGate(true);
    setPhase(idlePhase());
  }, [idlePhase, player, setGate]);

  // Reflect capture's own phase for the "hearing speech" indicator.
  useEffect(() => {
    if (!activeRef.current) return;
    if (capture.phase === "speaking") setPhase((p) => (p === "speaking" ? p : "hearing"));
    else if (capture.phase === "error") setPhase("error");
  }, [capture.phase]);

  return {
    active,
    phase,
    error,
    transcript,
    lastIntent,
    levelRef: capture.levelRef,
    toggle,
    interrupt,
  };
}
