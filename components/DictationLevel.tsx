"use client";

import { useEffect, useRef } from "react";

const BAR_COUNT = 7;

/**
 * Equalizer-style bars driven by a live audio level ref. Reads `levelRef.current`
 * on every animation frame and mutates bar heights directly, so the ~4 Hz level
 * updates from `useDictation` never re-render the chat input.
 */
export function DictationLevelMeter({ levelRef }: { levelRef: { current: number } }) {
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const level = levelRef.current ?? 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const bar = barRefs.current[i];
        if (!bar) continue;
        // Bell curve so center bars are taller, plus a per-bar sine wave so
        // bars dance independently as the level rises and falls.
        const bell = 1 - (Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2)) * 0.6;
        const wave = 0.55 + 0.45 * Math.sin(now / 140 + i * 1.25);
        const h = 3 + level * bell * wave * 19;
        bar.style.height = `${Math.max(3, Math.min(22, h))}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return (
    <div
      aria-hidden="true"
      style={{ display: "flex", alignItems: "center", gap: 2, height: 22, pointerEvents: "none" }}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <div
          key={i}
          ref={(el) => { barRefs.current[i] = el; }}
          style={{ width: 3, height: 3, borderRadius: 1, background: "var(--accent)", transition: "height 60ms linear" }}
        />
      ))}
    </div>
  );
}

/** Pulsing "processing…" indicator shown while transcription runs. */
export function DictationProcessing({ label }: { label: string }) {
  return (
    <div
      aria-hidden="true"
      style={{ pointerEvents: "none", fontSize: 13, color: "var(--text-dim)", animation: "pulse 1.4s ease-in-out infinite" }}
    >
      {label}
    </div>
  );
}
