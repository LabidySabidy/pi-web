"use client";

/**
 * Dev-only probe for Live Conversation capture (phase 2).
 *
 * Exercises microphone → Silero VAD → utterance segmentation with no routing and
 * no dispatch, so the capture path can be verified in a browser before anything
 * is wired to it. Each completed utterance is POSTed to the existing
 * `/api/transcribe` route so the audio is proven end-to-end, and the transcript is
 * shown rather than sent anywhere.
 *
 * Delete this page once the Live toggle ships. It exists only because the
 * capture path cannot be unit-tested -- it needs a real mic, a real
 * AudioWorklet, and a real sample rate.
 */

import { useCallback, useState } from "react";
import { useLiveCapture } from "@/hooks/useLiveCapture";
import { DictationLevelMeter } from "@/components/DictationLevel";
import { encodeWav } from "@/lib/audio";

interface Result {
  at: string;
  durationMs: number;
  samples: number;
  transcript: string | null;
  error?: string;
  transcribeMs?: number;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "idle",
  loading: "loading VAD model…",
  listening: "listening",
  speaking: "hearing speech",
  error: "error",
};

export function LiveCaptureProbe() {
  const [results, setResults] = useState<Result[]>([]);
  const [gateOpen, setGateOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const onUtterance = useCallback(async (utterance: { audio: Float32Array; sampleRate: number; durationMs: number }) => {
    const entry: Result = {
      at: new Date().toLocaleTimeString(),
      durationMs: Math.round(utterance.durationMs),
      samples: utterance.audio.length,
      transcript: null,
    };
    const startedAt = performance.now();
    setBusy(true);
    try {
      // Reuse the shipping dictation route, so this proves the audio is real and
      // correctly formatted rather than merely non-empty.
      const wav = encodeWav(utterance.audio, utterance.sampleRate);
      const res = await fetch("/api/transcribe", { method: "POST", body: wav });
      entry.transcribeMs = Math.round(performance.now() - startedAt);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        entry.error = data.error ?? `HTTP ${res.status}`;
      } else {
        const data = (await res.json()) as { text?: string };
        entry.transcript = data.text ?? "";
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      setBusy(false);
    }
    setResults((prev) => [entry, ...prev].slice(0, 12));
  }, []);

  const capture = useLiveCapture({ onUtterance });

  const toggleGate = () => {
    const next = !gateOpen;
    setGateOpen(next);
    capture.setCaptureEnabled(next);
  };

  const s = {
    page: { padding: 24, fontFamily: "ui-monospace, monospace", maxWidth: 900, margin: "0 auto", lineHeight: 1.6 },
    row: { display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" as const },
    btn: { padding: "6px 12px", border: "1px solid var(--border, #444)", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer" },
    card: { border: "1px solid var(--border, #444)", borderRadius: 8, padding: 10, marginBottom: 8 },
    dim: { color: "var(--text-dim, #888)", fontSize: 12 },
    badge: (ok: boolean) => ({
      display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 12,
      border: `1px solid ${ok ? "#2e7d32" : busy ? "#b26a00" : "#555"}`,
    }),
  };

  return (
    <main style={s.page}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Live capture probe (dev only)</h1>
      <p style={s.dim}>
        Mic → Silero VAD → utterance → <code>/api/transcribe</code>. Nothing is dispatched to any agent.
      </p>

      <div style={s.row}>
        <button style={s.btn} onClick={() => void capture.start()} disabled={capture.phase !== "idle" && capture.phase !== "error"}>
          Start capture
        </button>
        <button style={s.btn} onClick={capture.stop} disabled={capture.phase === "idle"}>
          Stop
        </button>
        <button style={s.btn} onClick={toggleGate}>
          Gate: {gateOpen ? "OPEN (accumulating)" : "CLOSED (ignoring speech)"}
        </button>
        <span style={s.badge(capture.phase === "error" ? false : true)}>{PHASE_LABEL[capture.phase] ?? capture.phase}</span>
        <DictationLevelMeter levelRef={capture.levelRef} />
        <span style={s.dim}>speech probability (live)</span>
      </div>

      {capture.error ? (
        <div style={{ ...s.card, borderColor: "#c62828" }}>
          <strong>Error:</strong> {capture.error}
        </div>
      ) : null}

      <h2 style={{ fontSize: 14, marginTop: 20 }}>Utterances ({results.length})</h2>
      {results.length === 0 ? (
        <p style={s.dim}>
          Start capture, say something, then stop talking for ~600ms. One entry should appear per utterance —
          not one per word, and not one per pause shorter than the silence window.
        </p>
      ) : null}
      {results.map((r, i) => (
        <div key={`${r.at}-${i}`} style={s.card}>
          <div style={s.dim}>
            {r.at} · {r.durationMs}ms speech · {r.samples} samples
            {r.transcribeMs !== undefined ? ` · transcribed in ${r.transcribeMs}ms` : ""}
          </div>
          {r.error ? (
            <div style={{ color: "#c62828" }}>transcribe failed: {r.error}</div>
          ) : (
            <div>{r.transcript?.trim() ? `“${r.transcript.trim()}”` : <em style={s.dim}>(empty transcript)</em>}</div>
          )}
        </div>
      ))}
    </main>
  );
}
