"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { computeLevel, encodeWav, resampleTo16k } from "@/lib/audio";

export type DictationPhase = "idle" | "recording" | "transcribing" | "error";

export interface DictationDevice {
  deviceId: string;
  label: string;
}

const TARGET_SAMPLE_RATE = 16000;

export interface DictationState {
  phase: DictationPhase;
  devices: DictationDevice[];
  deviceId: string | null;
  error: string | null;
  /** Live 0..1 audio level, updated per capture chunk without re-rendering. */
  levelRef: { current: number };
  start: () => void;
  stop: () => void;
  toggle: () => void;
  setDevice: (deviceId: string) => void;
  refreshDevices: () => void;
}

/**
 * Browser microphone capture → local whisper transcription.
 *
 * Captures mono PCM via getUserMedia + AudioContext (requesting 16 kHz, with a
 * linear resample fallback), WAV-encodes, POSTs to `/api/transcribe`, and hands
 * the transcribed text to `onText`.
 */
export function useDictation(onText: (text: string) => void): DictationState {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [devices, setDevices] = useState<DictationDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(TARGET_SAMPLE_RATE);
  const levelRef = useRef<number>(0);

  const refreshDevices = useCallback(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        const inputs = list
          .filter((d) => d.kind === "audioinput")
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          }));
        setDevices(inputs);
        setDeviceId((prev) => prev ?? inputs[0]?.deviceId ?? null);
      })
      .catch(() => {
        // leave the previous list in place
      });
  }, []);

  const start = useCallback(() => {
    if (phase === "recording") return;
    setError(null);
    chunksRef.current = [];

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
      },
    };

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        streamRef.current = stream;
        const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        ctxRef.current = ctx;
        sampleRateRef.current = ctx.sampleRate;
        // Autoplay policy: a context created after getUserMedia resolves is no
        // longer inside the click gesture, so browsers start it suspended.
        // Resume it or onaudioprocess never fires and no audio is captured.
        void ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => {
          const data = new Float32Array(e.inputBuffer.getChannelData(0));
          chunksRef.current.push(data);
          levelRef.current = computeLevel(data);
        };
        source.connect(node);
        node.connect(ctx.destination);
        nodeRef.current = node;
        setPhase("recording");
        // Permission is now granted — refresh so real device labels appear.
        refreshDevices();
      })
      .catch((err: unknown) => {
        levelRef.current = 0;
        setError(err instanceof Error ? err.message : "Microphone access failed");
        setPhase("error");
      });
  }, [deviceId, phase, refreshDevices]);

  const stop = useCallback(() => {
    if (phase !== "recording") return;

    const node = nodeRef.current;
    if (node) node.disconnect();
    nodeRef.current = null;

    const stream = streamRef.current;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const ctx = ctxRef.current;
    ctxRef.current = null;
    void ctx?.close();
    levelRef.current = 0;

    const chunks = chunksRef.current;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) {
      setPhase("idle");
      return;
    }
    const all = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.length;
    }

    const rate = sampleRateRef.current;
    const at16k = rate === TARGET_SAMPLE_RATE ? all : resampleTo16k(all, rate);
    const wav = encodeWav(at16k, TARGET_SAMPLE_RATE);

    setPhase("transcribing");
    setError(null);
    fetch("/api/transcribe", { method: "POST", body: wav })
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Transcription failed (${res.status})`);
        }
        return res.json() as Promise<{ text?: string }>;
      })
      .then((data) => {
        const text = data.text ?? "";
        if (text) onText(text);
        setPhase("idle");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Transcription failed");
        setPhase("error");
      });
  }, [phase, onText]);

  const toggle = useCallback(() => {
    if (phase === "recording") stop();
    else if (phase === "idle" || phase === "error") start();
  }, [phase, start, stop]);

  const setDevice = useCallback((id: string) => {
    setDeviceId(id);
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close();
    };
  }, []);

  return { phase, devices, deviceId, error, levelRef, start, stop, toggle, setDevice, refreshDevices };
}
