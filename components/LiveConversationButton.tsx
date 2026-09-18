"use client";

import { useI18n } from "@/hooks/useI18n";
import { DictationLevelMeter } from "@/components/DictationLevel";
import type { LiveConversationState, LivePhase } from "@/hooks/useLiveConversation";

/**
 * Live Conversation toggle and phase indicator.
 *
 * One button to start and stop the session, one to interrupt, and a phase label
 * so the user always knows whether they are being heard, whether the assistant
 * is thinking, and whether it is speaking. Without that the mic is a black box.
 */

interface Props {
  live: LiveConversationState;
}

function LiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20" />
      <path d="M8 6v12" />
      <path d="M4 9v6" />
      <path d="M16 6v12" />
      <path d="M20 9v6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** Short label for the current phase. Kept terse -- it sits inline in the composer. */
function phaseLabel(phase: LivePhase): string {
  switch (phase) {
    case "starting": return "starting…";
    case "listening": return "listening";
    case "hearing": return "hearing you…";
    case "transcribing": return "transcribing…";
    case "routing": return "thinking about that…";
    case "thinking": return "working…";
    case "speaking": return "speaking";
    case "error": return "error";
    default: return "off";
  }
}

export function LiveConversationButton({ live }: Props) {
  const { t } = useI18n();

  const label = phaseLabel(live.phase);
  const busy = live.phase === "transcribing" || live.phase === "routing";
  const speaking = live.phase === "speaking";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        onClick={live.toggle}
        aria-pressed={live.active}
        title={live.active ? t("chat.liveStop") : t("chat.liveStart")}
        aria-label={live.active ? t("chat.liveStop") : t("chat.liveStart")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "4px 8px",
          borderRadius: 6,
          cursor: "pointer",
          border: live.active ? "1px solid var(--accent)" : "1px solid var(--border)",
          background: live.active ? "var(--accent-soft, transparent)" : "transparent",
          color: live.active ? "var(--accent)" : "var(--text-dim)",
          fontSize: 12,
        }}
      >
        <LiveIcon />
        <span>Live</span>
      </button>

      {live.active ? (
        <>
          {/* Live mic level, so silence vs "mic is dead" is visible. */}
          <DictationLevelMeter levelRef={live.levelRef} />

          <span
            style={{
              fontSize: 11,
              color: live.phase === "error" ? "#c62828" : "var(--text-dim)",
              minWidth: 88,
            }}
            role="status"
            aria-live="polite"
          >
            {label}
          </span>

          {/* Only offered while speaking or busy: interrupting an idle session
              is a no-op, and a dead control is worse than no control. */}
          {speaking || busy || live.phase === "thinking" ? (
            <button
              type="button"
              onClick={live.interrupt}
              title={t("chat.liveInterrupt")}
              aria-label={t("chat.liveInterrupt")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 7px", borderRadius: 6, cursor: "pointer",
                border: "1px solid var(--border)", background: "transparent",
                color: "var(--text-dim)", fontSize: 11,
              }}
            >
              <StopIcon />
              <span>{t("chat.liveInterruptShort")}</span>
            </button>
          ) : null}

          {live.transcript ? (
            <span
              style={{
                fontSize: 11, color: "var(--text-dim)", maxWidth: 260,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
              title={live.transcript}
            >
              “{live.transcript}”
              {live.lastIntent ? ` → ${live.lastIntent}` : ""}
            </span>
          ) : null}

          {live.error ? (
            <span style={{ fontSize: 11, color: "#c62828" }} title={live.error}>
              {live.error}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
