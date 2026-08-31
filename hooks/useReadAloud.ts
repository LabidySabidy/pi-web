"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const ENABLED_KEY = "pi-read-aloud-enabled";
const VOICE_KEY = "pi-read-aloud-voice";

/** Fetch + speak + voice selection for the "read aloud" voice-output layer. */
export function useReadAloud() {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(ENABLED_KEY);
    return stored === null ? true : stored === "true";
  });
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoiceState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(VOICE_KEY);
  });
  const [voices, setVoices] = useState<string[]>([]);
  const [defaultVoice, setDefaultVoice] = useState("en_US-lessac-medium");

  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  const unlockAudio = useCallback(() => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }, [getCtx]);

  const loadVoices = useCallback(async () => {
    try {
      const res = await fetch("/api/speak/voices");
      if (!res.ok) return;
      const data = (await res.json()) as { voices?: unknown; defaultVoice?: unknown };
      if (Array.isArray(data.voices)) setVoices(data.voices.filter((v): v is string => typeof v === "string"));
      if (typeof data.defaultVoice === "string") setDefaultVoice(data.defaultVoice);
    } catch {
      // voices are optional — speak still works with the server default
    }
  }, []);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  const setVoice = useCallback((next: string) => {
    setVoiceState(next);
    try {
      localStorage.setItem(VOICE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(ENABLED_KEY, String(next));
    } catch {
      // ignore storage errors
    }
    if (next) unlockAudio();
  }, [unlockAudio]);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setError(null);
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        // already stopped
      }
      sourceRef.current = null;
    }
    setSpeaking(true);
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(voice ? { text, voice } : { text }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      const ctx = getCtx();
      if (!ctx) throw new Error("Audio playback is not available");
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const audioBuffer = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (sourceRef.current === src) sourceRef.current = null;
        setSpeaking(false);
      };
      sourceRef.current = src;
      src.start();
    } catch (e) {
      setSpeaking(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [getCtx, voice]);

  return {
    enabled,
    setEnabled,
    speaking,
    error,
    speak,
    voice: voice ?? defaultVoice,
    setVoice,
    voices,
    defaultVoice,
    loadVoices,
    unlockAudio,
  };
}
