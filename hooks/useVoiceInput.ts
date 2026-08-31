"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav, resampleTo16k } from "@/lib/audio";

const TARGET_RATE = 16000;
const ROLLING_SECONDS = 2;
const KWS_POLL_MS = 1000;
// Drop trailing audio (the spoken "finalize") before transcribing.
const TRAILING_TRIM_SAMPLES = Math.round(TARGET_RATE * 1.2);
const STORAGE_KEY = "pi-voice-input-enabled";

export type VoiceInputPhase = "idle" | "armed" | "recording" | "transcribing";

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function toBase64Pcm16k(chunks: Float32Array[], fromRate: number): string {
  const all = concat(chunks);
  if (all.length === 0) return "";
  const at16k = fromRate === TARGET_RATE ? all : resampleTo16k(all, fromRate);
  const int16 = new Int16Array(at16k.length);
  for (let i = 0; i < at16k.length; i++) {
    const v = Math.max(-1, Math.min(1, at16k[i]));
    int16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Continuous voice input: listen for "jarvis" (wake), record freely (silence
 * tolerated), listen for "finalize" (stop), then transcribe and auto-send.
 */
export function useVoiceInput(onSend: (text: string) => void) {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  });
  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [lastDetected, setLastDetected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phaseRef = useRef<VoiceInputPhase>("idle");
  const sampleRateRef = useRef<number>(TARGET_RATE);
  const rollingRef = useRef<Float32Array[]>([]);
  const recordingRef = useRef<Float32Array[]>([]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // ignore storage errors
    }
  }, []);

  const finalize = useCallback(() => {
    const chunks = recordingRef.current;
    recordingRef.current = [];
    const all = concat(chunks);
    if (all.length === 0) {
      phaseRef.current = "armed";
      setPhase("armed");
      return;
    }
    setPhase("transcribing");
    phaseRef.current = "transcribing";
    setError(null);
    const rate = sampleRateRef.current;
    const at16k = rate === TARGET_RATE ? all : resampleTo16k(all, rate);
    const trimmed = at16k.length > TRAILING_TRIM_SAMPLES
      ? at16k.subarray(0, at16k.length - TRAILING_TRIM_SAMPLES)
      : at16k;
    const wav = encodeWav(trimmed, TARGET_RATE);
    fetch("/api/transcribe", { method: "POST", body: wav })
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Transcription failed (${res.status})`);
        }
        return res.json() as Promise<{ text?: string }>;
      })
      .then((data) => {
        const text = (data.text ?? "").trim();
        if (text) onSend(text);
        phaseRef.current = "armed";
        setPhase("armed");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Transcription failed");
        phaseRef.current = "armed";
        setPhase("armed");
      });
  }, [onSend]);

  const pollKws = useCallback(async () => {
    const rolling = rollingRef.current;
    if (rolling.length === 0) return;
    const b64 = toBase64Pcm16k(rolling, sampleRateRef.current);
    if (!b64) return;
    try {
      const res = await fetch("/api/kws", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: b64 }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { detected?: string | null };
      const detected = data.detected ?? null;
      if (detected) setLastDetected(detected);
      const current = phaseRef.current;
      if (detected === "jarvis" && current === "armed") {
        rollingRef.current = [];
        recordingRef.current = [];
        phaseRef.current = "recording";
        setPhase("recording");
      } else if (detected === "finalize" && current === "recording") {
        finalize();
      }
    } catch {
      // ignore transient KWS errors
    }
  }, [finalize]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let node: ScriptProcessorNode | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        sampleRateRef.current = ctx.sampleRate;
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => {
          const data = new Float32Array(e.inputBuffer.getChannelData(0));
          const maxChunks = Math.max(1, Math.ceil((ctx!.sampleRate * ROLLING_SECONDS) / data.length));
          rollingRef.current.push(data);
          if (rollingRef.current.length > maxChunks) {
            rollingRef.current.splice(0, rollingRef.current.length - maxChunks);
          }
          if (phaseRef.current === "recording") {
            recordingRef.current.push(data);
          }
        };
        const source = ctx.createMediaStreamSource(stream);
        const sink = ctx.createGain();
        sink.gain.value = 0; // muted sink so the graph is pulled without echoing
        source.connect(node);
        node.connect(sink);
        sink.connect(ctx.destination);

        timer = setInterval(() => {
          void pollKws();
        }, KWS_POLL_MS);
        phaseRef.current = "armed";
        setPhase("armed");
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Microphone unavailable");
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (node) node.disconnect();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      rollingRef.current = [];
      recordingRef.current = [];
      if (phaseRef.current !== "transcribing") {
        phaseRef.current = "idle";
        setPhase("idle");
      }
    };
  }, [enabled, pollKws]);

  return { enabled, setEnabled, phase, lastDetected, error };
}
