"use client";

import { useState } from "react";
import { useProjectState } from "@/hooks/useProjectState";
import { formatProjectStateLine, type ProjectState, type SourceStatus } from "@/lib/project-state";
import type { SessionStatsInfo } from "@/lib/pi-types";

interface Props {
  cwd: string | null | undefined;
  refreshKey?: number;
  sessionStats?: SessionStatsInfo | null;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
}

const SOURCE_LABELS: Array<{ key: keyof ProjectState["sources"]; label: string }> = [
  { key: "plan", label: "PLAN" },
  { key: "tasks", label: "TASKS" },
  { key: "progress", label: "PROGRESS" },
  { key: "decisions", label: "DECISIONS" },
  { key: "vision", label: "VISION" },
];

function sourceGlyph(status: SourceStatus): string {
  if (status === "present") return "✓";
  if (status === "error") return "!";
  return "—";
}

/**
 * Collapsible project-state header shown above the chat. The collapsed strip is
 * the verdict one-liner; expanding reveals phases, open questions, latest
 * progress, the last decision, source presence, and the cost/context stats
 * pi-web already tracks.
 */
export function ProjectStateHeader({ cwd, refreshKey = 0, sessionStats, contextUsage }: Props) {
  const result = useProjectState(cwd, refreshKey);
  const [expanded, setExpanded] = useState(false);

  if (result.status === "idle" || result.status === "loading" || result.status === "error") {
    return null;
  }

  const state = result.state;
  const line = formatProjectStateLine(state);
  const hasSources = Object.values(state.sources).some((status) => status === "present");
  if (!line && !hasSources) return null;

  const cost = sessionStats?.cost ?? 0;
  const contextPercent = contextUsage?.percent;
  const contextWindow = contextUsage?.contextWindow;
  const hasStats = cost > 0 || contextWindow !== undefined;

  return (
    <div
      style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 16px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--text)",
          textAlign: "left",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span
          aria-hidden="true"
          style={{ color: "var(--text-dim)", width: 10, flexShrink: 0, transition: "transform 0.1s", transform: expanded ? "rotate(90deg)" : "none" }}
        >
          ▸
        </span>
        <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {line || "Project state"}
        </span>
        {hasStats && !expanded && (
          <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            {cost > 0 ? `$${cost.toFixed(2)}` : ""}
            {cost > 0 && contextWindow ? " · " : ""}
            {contextWindow ? `${contextPercent != null ? `${contextPercent.toFixed(0)}%` : "?"} / ${contextWindow.toLocaleString()}` : ""}
          </span>
        )}
      </button>

      {expanded && (
        <div style={{ padding: "2px 16px 12px 34px", display: "grid", gap: 10 }}>
          {state.phases.length > 0 && (
            <Section title="Phases">
              {state.phases.map((phase) => (
                <div key={phase.number} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ color: "var(--accent)", flexShrink: 0 }}>Phase {phase.number}</span>
                  <span style={{ color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {phase.title || "(untitled)"}
                  </span>
                  <span style={{ color: "var(--text-dim)", marginLeft: "auto", flexShrink: 0 }}>
                    {phase.completion !== null
                      ? `${phase.completion}%`
                      : `${phase.done} done / ${phase.pending} pending`}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {state.blocked && state.blocked.count > 0 && (
            <Section title={`Blocked (${state.blocked.count})`}>
              {state.blocked.reasons.map((reason, index) => (
                <div key={index} style={{ color: "var(--text-muted)" }}>
                  • {reason}
                </div>
              ))}
            </Section>
          )}

          {state.openQuestions && state.openQuestions.count > 0 && (
            <Section title={`Open questions (${state.openQuestions.count})`}>
              {state.openQuestions.items.map((question, index) => (
                <div key={index} style={{ color: "var(--text-muted)" }}>
                  • {question}
                </div>
              ))}
            </Section>
          )}

          {state.latestProgress && (
            <Section title="Latest progress">
              <div style={{ color: "var(--text)" }}>
                {state.latestProgress.timestamp && (
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>{state.latestProgress.timestamp}</span>
                )}
                <InlineMarkdown text={state.latestProgress.summary} />
              </div>
              {state.latestProgress.body && (
                <div style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", marginTop: 4 }}>
                  <InlineMarkdown text={state.latestProgress.body} />
                </div>
              )}
            </Section>
          )}

          {state.lastDecision && (
            <Section title="Last decision">
              <div style={{ color: "var(--text)" }}>
                {state.lastDecision.date && (
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>{state.lastDecision.date}</span>
                )}
                {state.lastDecision.title}
              </div>
              {state.lastDecision.summary && (
                <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{state.lastDecision.summary}</div>
              )}
            </Section>
          )}

          {hasStats && (
            <Section title="Session">
              <div style={{ color: "var(--text-muted)" }}>
                {cost > 0 ? `cost $${cost.toFixed(4)}` : ""}
                {cost > 0 && contextWindow ? " · " : ""}
                {contextWindow
                  ? `context ${contextPercent != null ? `${contextPercent.toFixed(1)}%` : "unknown"} of ${contextWindow.toLocaleString()} tokens`
                  : ""}
              </div>
            </Section>
          )}

          <Section title="Sources">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", color: "var(--text-dim)" }}>
              {SOURCE_LABELS.map(({ key, label }) => {
                const status = state.sources[key];
                return (
                  <span key={key} style={{ color: status === "present" ? "var(--text)" : "var(--text-dim)" }}>
                    {label} {sourceGlyph(status)}
                  </span>
                );
              })}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * Render the recap's inline markdown (**bold**, `code`, *italic*) without a full
 * markdown pipeline — the session-summary format uses only these three, and a
 * full renderer would collapse the recap's single-newline line breaks.
 */
function InlineMarkdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(
        <code
          key={key++}
          style={{
            background: "var(--bg-subtle)",
            borderRadius: 5,
            padding: "1px 5px",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.92em",
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
