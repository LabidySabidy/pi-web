"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DictationState } from "@/hooks/useDictation";

export interface WhisperStatus {
  available: boolean;
  running: boolean;
  warmingUp: boolean;
  error: string | null;
  models: { name: string; path: string; bytes: number }[];
  currentModel: string | null;
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function DictationButton({ dictation }: { dictation: DictationState }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(() => {
    fetch("/api/whisper/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setStatus(data as WhisperStatus | null))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const warmingUp = status?.warmingUp ?? false;
  useEffect(() => {
    if (!warmingUp) return;
    const id = setInterval(refreshStatus, 1500);
    return () => clearInterval(id);
  }, [warmingUp, refreshStatus]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const switchModel = useCallback((name: string) => {
    fetch("/api/whisper/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data && typeof data === "object" && !("error" in data)) setStatus(data as WhisperStatus);
      })
      .catch(() => {
        // leave status as-is; the next poll retries
      });
  }, []);

  if (!status?.available) return null;

  const { phase, devices, deviceId, error, toggle, setDevice } = dictation;
  const recording = phase === "recording";
  const transcribing = phase === "transcribing";
  // Recording must stay clickable: the mic is also the stop button. Only
  // transcribing and whisper warm-up disable it — otherwise the user can never
  // stop a recording (the button shows a not-allowed cursor and ignores clicks).
  const busy = transcribing || warmingUp;

  const color = recording
    ? "#ef4444"
    : transcribing
      ? "var(--accent)"
      : warmingUp
        ? "var(--text-dim)"
        : "var(--text-muted)";

  const title = recording
    ? t("chat.stopDictation")
    : transcribing
      ? t("chat.dictationTranscribing")
      : warmingUp
        ? t("chat.dictationWarmingUp")
        : error
          ? error
          : t("chat.dictate");

  return (
    <div ref={menuRef} style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0 }}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={title}
        aria-label={title}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: recording ? "rgba(239,68,68,0.12)" : "none",
          border: "none",
          borderRadius: 9,
          color,
          cursor: busy ? "not-allowed" : "pointer",
          opacity: warmingUp && !recording ? 0.55 : 1,
          transition: "background 0.12s, color 0.12s, opacity 0.12s",
        }}
        onMouseEnter={(e) => {
          if (!busy) e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = recording ? "#ef4444" : "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = recording ? "rgba(239,68,68,0.12)" : "none";
          e.currentTarget.style.color = color;
        }}
      >
        <MicIcon />
      </button>
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        title={t("chat.dictationSettings")}
        aria-label={t("chat.dictationSettings")}
        aria-expanded={menuOpen}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 32,
          padding: 0,
          background: "none",
          border: "none",
          borderRadius: 9,
          color: "var(--text-dim)",
          cursor: "pointer",
        }}
      >
        <ChevronIcon />
      </button>

      {menuOpen && (
        <div
          style={{
            position: "absolute",
            bottom: 38,
            right: 0,
            zIndex: 40,
            minWidth: 220,
            padding: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            {t("chat.dictationDevice")}
            <select
              value={deviceId ?? ""}
              onChange={(e) => setDevice(e.target.value)}
              style={{
                background: "var(--bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 7,
                padding: "5px 6px",
                fontSize: 12,
                maxWidth: 220,
              }}
            >
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            {t("chat.dictationModel")}
            <select
              value={status.currentModel ?? ""}
              onChange={(e) => switchModel(e.target.value)}
              style={{
                background: "var(--bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 7,
                padding: "5px 6px",
                fontSize: 12,
                maxWidth: 220,
              }}
            >
              {status.models.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
