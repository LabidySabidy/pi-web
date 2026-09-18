"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlaybackGate } from "@/lib/playback-gate";

/**
 * Interruptible speech playback for Live Conversation mode.
 *
 * Plays WAV returned by the speech routes through WebAudio, and can be cut off
 * mid-utterance for barge-in. Kept separate from `useReadAloud` because the
 * requirements differ: read-aloud is user-initiated and fires on turn
 * completion, whereas Live mode must start, stop and report completion as part
 * of a turn lifecycle -- and a barge-in has to silence audio that is already
 * playing, not merely stop scheduling more.
 *
 * Shares the playback mechanism deliberately (AudioContext + AudioBufferSource
 * -> destination), so the voice sounds identical to read-aloud.
 */

export interface LivePlayer {
  /** True while audio is actually playing. */
  playing: boolean;
  /** Play WAV bytes. Resolves when playback finishes or is stopped. */
  play: (wav: ArrayBuffer) => Promise<void>;
  /** Stop immediately. Safe to call when nothing is playing. */
  stop: () => void;
  /** Total bytes played since the last reset, for diagnostics. */
  bytesRef: { current: number };
}

export function useLivePlayer(options: { onStart?: () => void; onEnd?: () => void } = {}): LivePlayer {
  const [playing, setPlaying] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const bytesRef = useRef(0);
  /**
   * Arbitrates which audio may be heard and ensures completion fires once.
   * See lib/playback-gate.ts for the races it prevents.
   */
  const gateRef = useRef(new PlaybackGate());
  const onStartRef = useRef(options.onStart);
  const onEndRef = useRef(options.onEnd);
  onStartRef.current = options.onStart;
  onEndRef.current = options.onEnd;

  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  /** Settle the in-flight play() promise exactly once. */
  const settle = useCallback(() => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    if (resolve) resolve();
  }, []);

  const stop = useCallback(() => {
    const src = sourceRef.current;
    if (src) {
      try {
        src.onended = null; // we are ending this, not the audio
        src.stop();
      } catch {
        // already stopped
      }
      sourceRef.current = null;
    }
    setPlaying(false);
    settle();
    if (gateRef.current.stop() === "end") onEndRef.current?.();
  }, [settle]);

  const play = useCallback(
    async (wav: ArrayBuffer) => {
      // Replace any current audio rather than layering over it: overlapping
      // speech is unintelligible and would also double-trigger the mic.
      stop();

      const ctx = getCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});

      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(wav.slice(0));
      } catch {
        return; // malformed audio; nothing to play, nothing to report
      }

      bytesRef.current += wav.byteLength;

      // Replacing audio is a barge-in: the gate discards the superseded
      // utterance's pending completion so it cannot clear this one's state.
      const token = gateRef.current.begin();

      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => {
          // finish() only fires for the current generation, and only once, so
          // a stop() racing this cannot announce completion twice.
          if (gateRef.current.finish(token) !== "end") return;
          if (sourceRef.current === src) sourceRef.current = null;
          setPlaying(false);
          settle();
          onEndRef.current?.();
        };
        resolveRef.current = resolve;
        sourceRef.current = src;
        setPlaying(true);
        onStartRef.current?.();
        src.start();
      });
    },
    [getCtx, settle, stop],
  );

  useEffect(() => {
    return () => {
      sourceRef.current?.stop?.();
      void ctxRef.current?.close();
    };
  }, []);

  return { playing, play, stop, bytesRef };
}
