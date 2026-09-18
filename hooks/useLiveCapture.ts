"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Utterance segmentation for Live Conversation mode.
 *
 * Continuous mic capture → Silero VAD → one complete utterance (Float32 @16 kHz)
 * per speaking turn. This is the *capture* half of Live mode: it decides when the
 * user started and stopped talking. Routing and dispatch live elsewhere.
 *
 * Why a pure-JS VAD: the widely-used `@ricky0123/vad-web` pulls in
 * `onnxruntime-web` (144 MB unpacked) and its WASM path is broken on iOS
 * Safari 16.4+. `@jorastechnologies/silvero-vad-js` reimplements the same
 * SileroVAD v5 forward pass in ~1.2 MB with zero dependencies, and was verified
 * on this machine to separate speech from non-speech cleanly (speech avg
 * p=0.94 with 94% of frames > 0.5; silence/tone/noise all < 0.01).
 *
 * The recorder is driven manually rather than via the package's `VADRecorder`
 * so that capture can be gated (see `setCaptureEnabled`) without tearing down
 * the mic — which is what makes half-duplex playback cheap.
 */

import { UtteranceSegmenter } from "@/lib/utterance-segmenter";

export type UtterancePhase = "idle" | "loading" | "listening" | "speaking" | "error";

export interface LiveUtterance {
  /** 16 kHz mono PCM, -1..1. */
  audio: Float32Array;
  sampleRate: number;
  /** Wall-clock ms from first detected speech to utterance end. */
  durationMs: number;
}

export interface LiveCaptureOptions {
  /** Probability above which a frame counts as speech. */
  threshold?: number;
  /** Trailing silence (ms) that ends an utterance. */
  silenceMs?: number;
  /** Utterances shorter than this are discarded as noise. */
  minSpeechMs?: number;
  /** Hard cap so a stuck-open mic cannot grow without bound. */
  maxUtteranceMs?: number;
  /** Called once per completed utterance. */
  onUtterance: (utterance: LiveUtterance) => void;
  onError?: (message: string) => void;
}

export interface LiveCaptureState {
  phase: UtterancePhase;
  error: string | null;
  /** 0..1 speech probability of the most recent frame, for a live meter. */
  levelRef: { current: number };
  start: () => Promise<void>;
  stop: () => void;
  /** Suspend/resume capture without releasing the mic (half-duplex gate). */
  setCaptureEnabled: (enabled: boolean) => void;
}

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;
const WORKLET_URL = "/vad/vad_processor.js";
const WEIGHTS_BIN_URL = "/vad/silero_vad_v5.bin";
const WEIGHTS_MANIFEST_URL = "/vad/silero_vad_v5.manifest.json";

/** Constructing the VAD is expensive; cache it across hook instances. */
type VadLike = { process: (frame: Float32Array) => number; reset?: () => void };
let cachedVad: VadLike | null = null;
let vadLoad: Promise<VadLike> | null = null;

async function loadVad(): Promise<VadLike> {
  if (cachedVad) return cachedVad;
  if (vadLoad) return vadLoad;
  vadLoad = (async () => {
    const [{ SileroVADJS, loadWeightsFromBuffers }, binResp, manifestResp] = await Promise.all([
      import("@jorastechnologies/silvero-vad-js"),
      fetch(WEIGHTS_BIN_URL),
      fetch(WEIGHTS_MANIFEST_URL),
    ]);
    if (!binResp.ok) throw new Error(`VAD weights: ${binResp.status}`);
    if (!manifestResp.ok) throw new Error(`VAD manifest: ${manifestResp.status}`);
    const [arrayBuffer, manifest] = await Promise.all([binResp.arrayBuffer(), manifestResp.json()]);
    const weights = loadWeightsFromBuffers(arrayBuffer, manifest);
    cachedVad = new SileroVADJS(weights, SAMPLE_RATE) as unknown as VadLike;
    return cachedVad;
  })();
  try {
    return await vadLoad;
  } catch (error) {
    vadLoad = null;
    throw error;
  }
}

export function useLiveCapture(options: LiveCaptureOptions): LiveCaptureState {
  const {
    threshold = 0.5,
    silenceMs = 600,
    minSpeechMs = 250,
    maxUtteranceMs = 60_000,
    onUtterance,
    onError,
  } = options;

  const [phase, setPhase] = useState<UtterancePhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const vadRef = useRef<VadLike | null>(null);
  const segmenterRef = useRef<UtteranceSegmenter | null>(null);
  const levelRef = useRef(0);

  // The gate lives in a ref because the worklet callback is not a React render
  // boundary and must read the current value.
  const enabledRef = useRef(false);
  const onUtteranceRef = useRef(onUtterance);
  const onErrorRef = useRef(onError);
  onUtteranceRef.current = onUtterance;
  onErrorRef.current = onError;

  const resetUtterance = useCallback(() => {
    segmenterRef.current?.reset();
  }, []);

  const handleFrame = useCallback(
    (frame: Float32Array) => {
      const vad = vadRef.current;
      const segmenter = segmenterRef.current;
      if (!vad || !segmenter) return;

      // Always run the model so the level meter stays live, even while the gate
      // is closed. Running it during playback also keeps the model's recurrent
      // state warm, so the first frame after resuming is not blind.
      let probability = 0;
      try {
        probability = vad.process(frame);
      } catch (err) {
        onErrorRef.current?.(err instanceof Error ? err.message : "VAD frame failed");
        return;
      }
      levelRef.current = probability;

      if (!enabledRef.current) return;

      for (const event of segmenter.push(frame, probability, Date.now())) {
        if (event.type === "speech-start") setPhase("speaking");
        else if (event.type === "speech-end") {
          onUtteranceRef.current(event.utterance);
          setPhase("listening");
        }
      }
    },
    [],
  );

  const start = useCallback(async () => {
    if (ctxRef.current) return;
    setError(null);
    setPhase("loading");

    try {
      const vad = await loadVad();
      vadRef.current = vad;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // "all" cancels ALL system playout, not just RTCPeerConnection audio.
          // Chrome's AEC ignores locally-generated WebAudio otherwise, which is
          // what let the mic record its own TTS. Types say ConstrainBoolean; the
          // spec allows the string.
          echoCancellation: "all" as unknown as boolean,
          // Kept off: these gate the raw signal and the VAD model prefers it
          // untouched (and dictation relies on the same reasoning).
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: SAMPLE_RATE,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      ctxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      await ctx.audioWorklet.addModule(WORKLET_URL);

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const node = new AudioWorkletNode(ctx, "vad-processor");
      nodeRef.current = node;

      segmenterRef.current = new UtteranceSegmenter({
        threshold,
        silenceMs,
        minSpeechMs,
        maxUtteranceMs,
        frameSamples: FRAME_SAMPLES,
        sampleRate: SAMPLE_RATE,
      });

      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; frame?: Float32Array };
        if (data?.type === "frame" && data.frame) handleFrame(data.frame);
      };

      // Deliberately NOT connected to ctx.destination: routing mic input to the
      // speakers causes feedback and, on mobile, forces the context into
      // voice-communication mode. The worklet processes without an output edge.
      source.connect(node);

      enabledRef.current = true;
      resetUtterance();
      setPhase("listening");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Microphone access failed";
      setError(message);
      setPhase("error");
      onErrorRef.current?.(message);
    }
  }, [handleFrame, resetUtterance, threshold, silenceMs, minSpeechMs, maxUtteranceMs]);

  const stop = useCallback(() => {
    enabledRef.current = false;
    resetUtterance();

    nodeRef.current?.port.close();
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    levelRef.current = 0;
    setPhase("idle");
  }, [resetUtterance]);

  const setCaptureEnabled = useCallback(
    (enabled: boolean) => {
      enabledRef.current = enabled;
      if (!enabled) {
        // Drop any partial utterance: playback is starting, and a sentence
        // captured in two disconnected halves is worse than none.
        resetUtterance();
        setPhase("listening");
      }
    },
    [resetUtterance],
  );

  useEffect(() => {
    return () => {
      nodeRef.current?.port.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void ctxRef.current?.close();
    };
  }, []);

  return { phase, error, levelRef, start, stop, setCaptureEnabled };
}
