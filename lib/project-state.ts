/**
 * Project-state parser: reads the harness's durable memory files
 * (PLAN.md / TASKS.md / PROGRESS.md / DECISIONS.md / VISION.md) from a
 * project root and composes them into a single glanceable `ProjectState`.
 *
 * Design rules:
 * - Pure markdown parsing. No filesystem I/O here — the route feeds bounded
 *   strings in. Absence is `null` input, not an empty string.
 * - Graceful degradation: a parser never throws. Malformed input degrades to a
 *   partial parse. The `sources` map reports `absent` vs `present` per file so
 *   the UI can distinguish "unknown" from "looked and found nothing".
 * - `blocked` is three-valued, derived ONLY from TASKS.md task lines matching
 *   blocked/blocker/blocking/waiting-on. It is independent of open questions.
 * - Open questions are a separate segment from PLAN.md `## Open questions`.
 */

export type MemorySource = "plan" | "tasks" | "progress" | "decisions" | "vision";
export type SourceStatus = "present" | "absent" | "error";

export interface PhaseSummary {
  number: number;
  title: string;
  done: number; // completed task checkboxes (0 when sourced from PLAN)
  pending: number; // incomplete task checkboxes (0 when sourced from PLAN)
  completion: number | null; // 0-100 from PLAN "(X% complete)"; null from TASKS
}

export interface ProjectState {
  /**
   * Lowest-numbered incomplete phase, or null when no phase structure exists.
   * `current` is null when phases are known but per-phase completion is not
   * tracked (the standard `## Phases` list format).
   */
  phase: { current: number | null; total: number; title?: string } | null;
  /**
   * Three-valued: null = no TASKS.md to judge from; {count:0} = looked, nothing
   * blocked; {count:N} = N blocked task lines. Independent of open questions.
   */
  blocked: { count: number; reasons: string[] } | null;
  /** Separate from blocked. null = no PLAN.md; {count:0} = no open questions. */
  openQuestions: { count: number; items: string[] } | null;
  lastDecision: { title: string; date?: string; summary?: string } | null;
  /** Phase 4 (deferred): always null until the baseline snapshot exists. */
  movedSince: { completedDelta: number; sinceLabel: string } | null;
  phases: PhaseSummary[];
  latestProgress: { timestamp?: string; summary: string; body?: string } | null;
  sources: Record<MemorySource, SourceStatus>;
}

export interface ProjectStateInput {
  plan: string | null;
  tasks: string | null;
  progress: string | null;
  decisions: string | null;
  vision: string | null;
}

// ============================================================================
// Shared regexes (hyphen kept last in each char class to avoid range syntax)
// ============================================================================

const PHASE_HEADING_SEP = "[—–:-]";
const TASKS_PHASE_RE = new RegExp(
  `^##\\s+Phase\\s+(\\d+)\\s*(?:${PHASE_HEADING_SEP}\\s*(.*?))?\\s*$`,
  "i",
);
const PLAN_PHASE_RE = new RegExp(
  `^###\\s+Phase\\s+(\\d+)\\s*(?:${PHASE_HEADING_SEP}\\s*(.*?))?\\s*$`,
  "i",
);
const H2_RE = /^##\s+(.*)$/;
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s*(.*)$/;
// "blocked"/"blocker"/"blocking" as whole words, or "waiting on"; never bare "block".
const BLOCKED_RE = /\bblock(?:ed|er|ing)\b|\bwaiting\s+on\b/i;

// ============================================================================
// parseTasks — TASKS.md
// ============================================================================

export interface TasksParse {
  phases: { number: number; title: string; done: number; pending: number }[];
  unphasedDone: number;
  unphasedPending: number;
  blocked: { count: number; reasons: string[] };
}

export function parseTasks(md: string): TasksParse {
  const phases: TasksParse["phases"] = [];
  const blocked = { count: 0, reasons: [] as string[] };
  let unphasedDone = 0;
  let unphasedPending = 0;
  let current: TasksParse["phases"][number] | null = null;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    const phaseMatch = TASKS_PHASE_RE.exec(trimmed);
    if (phaseMatch) {
      const number = parseInt(phaseMatch[1], 10);
      current = { number, title: (phaseMatch[2] ?? "").trim(), done: 0, pending: 0 };
      phases.push(current);
      continue;
    }

    // An unnumbered `## ` section (e.g. "## Design System Redesign") ends the
    // current phase so its tasks are not mis-attributed to the previous one.
    if (/^##\s+/.test(trimmed)) {
      current = null;
      continue;
    }

    const checkbox = CHECKBOX_RE.exec(line);
    if (!checkbox) continue;
    const checked = checkbox[1].toLowerCase() === "x";
    const text = checkbox[2].trim();

    if (current) {
      if (checked) current.done += 1;
      else current.pending += 1;
    } else {
      if (checked) unphasedDone += 1;
      else unphasedPending += 1;
    }

    // Only incomplete tasks can be "blocked" — a done checkbox isn't blocking.
    if (!checked && BLOCKED_RE.test(text)) {
      blocked.count += 1;
      blocked.reasons.push(text);
    }
  }

  return { phases, unphasedDone, unphasedPending, blocked };
}

// ============================================================================
// parsePlan — PLAN.md
// ============================================================================

export interface PlanParse {
  phases: { number: number; title: string; completion: number | null }[];
  openQuestions: string[];
}

function extractCompletion(title: string): number | null {
  const pct = /(\d{1,3})%\s*(?:complete)?/i.exec(title);
  if (pct) return Math.min(100, parseInt(pct[1], 10));
  if (/✅|complete/i.test(title)) return 100;
  return null;
}

function stripCompletion(title: string): string {
  return title
    .replace(/\s*\(?\d{1,3}%\s*complete\)?\s*$/i, "")
    .replace(/\s*✅\s*complete\s*$/i, "")
    .trim();
}

/** Parse one `1. **Title** — description` line from a `## Phases` list. */
function parsePhaseListItem(text: string): { number: number; title: string } | null {
  const item = /^(\d+)[.)]\s+(.+)$/.exec(text);
  if (!item) return null;
  const number = parseInt(item[1], 10);
  const rest = item[2].trim();
  const bold = /^\*\*(.+?)\*\*/.exec(rest);
  let title: string;
  if (bold) {
    title = bold[1].trim();
  } else {
    const sep = /^(.+?)\s*[—–:-]\s*/.exec(rest);
    title = (sep ? sep[1] : rest).trim();
  }
  return { number, title };
}

export function parsePlan(md: string): PlanParse {
  const phases: PlanParse["phases"] = [];
  const openQuestions: string[] = [];
  let section: string | null = null;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    const h2 = H2_RE.exec(trimmed);
    if (h2) {
      const name = h2[1].trim();
      if (/^phases/i.test(name)) section = "phases";
      else if (/^open questions/i.test(name)) section = "open-questions";
      else section = name.toLowerCase();
      continue;
    }

    // EasyOBD-style: `### Phase N — Title (X% complete)` under any section.
    if (/^###\s+/.test(trimmed)) {
      const phaseMatch = PLAN_PHASE_RE.exec(trimmed);
      if (phaseMatch) {
        const number = parseInt(phaseMatch[1], 10);
        const titleRaw = (phaseMatch[2] ?? "").trim();
        phases.push({
          number,
          title: stripCompletion(titleRaw),
          completion: extractCompletion(titleRaw),
        });
      }
      continue;
    }

    // Standard template: `## Phases` numbered list.
    if (section === "phases") {
      const item = parsePhaseListItem(trimmed);
      if (item) phases.push({ number: item.number, title: item.title, completion: null });
      continue;
    }

    if (section === "open-questions") {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const text = (bullet ? bullet[1] : line).trim();
      // "None", "None.", "N/A", "Nothing" are placeholders, not questions.
      const normalized = text.replace(/[.。]\s*$/, "").trim();
      if (normalized && !/^(none|n\/a|none yet|nothing)$/i.test(normalized)) {
        openQuestions.push(text);
      }
    }
  }

  return { phases, openQuestions };
}

// ============================================================================
// parseProgress — PROGRESS.md
// ============================================================================

export interface ProgressEntry {
  timestamp?: string;
  summary: string;
  body?: string;
}

export interface ProgressParse {
  entries: ProgressEntry[];
}

const PROGRESS_HEADING_RE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2})(?:\\s+(\\d{1,2}:\\d{2}))?\\s*${PHASE_HEADING_SEP}\\s*(.*)$`,
);

export function parseProgress(md: string): ProgressParse {
  const entries: ProgressEntry[] = [];
  let current: ProgressEntry | null = null;
  let inProgressFence = false;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (/^<!--\s*session-in-progress/.test(trimmed)) {
      inProgressFence = true;
      continue;
    }
    if (/^<!--\s*end-session-in-progress/.test(trimmed)) {
      inProgressFence = false;
      continue;
    }
    if (inProgressFence) continue;

    const h = H2_RE.exec(trimmed);
    if (h) {
      const heading = h[1].trim();
      const parsed = PROGRESS_HEADING_RE.exec(heading);
      if (parsed) {
        if (current) entries.push(current);
        const date = parsed[1];
        const time = parsed[2];
        current = {
          timestamp: time ? `${date} ${time}` : date,
          summary: parsed[3].trim(),
        };
      } else if (current) {
        // A bare `##` inside a summary body (rare) stays attached.
        current.body = current.body === undefined
          ? `## ${heading}`
          : `${current.body}\n## ${heading}`;
      }
      continue;
    }

    if (current) {
      const text = line.trim();
      if (!text) continue;
      current.body = current.body === undefined ? text : `${current.body}\n${text}`;
    }
  }

  if (current && current.summary) entries.push(current);
  return { entries };
}

// ============================================================================
// parseDecisions — DECISIONS.md (ADR-lite)
// ============================================================================

export interface DecisionsParse {
  latest: { title: string; date?: string; summary?: string } | null;
}

export function parseDecisions(md: string): DecisionsParse {
  const entries: { title: string; date?: string; summary?: string }[] = [];
  let current: { title: string; date?: string; summary?: string } | null = null;
  let inFence = false;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (/^\s*```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = H2_RE.exec(trimmed);
    if (h) {
      const heading = h[1].trim();
      if (/^template$/i.test(heading)) {
        current = null;
        continue;
      }
      const dated = /^(\d{4}-\d{2}-\d{2})\s*[—–:-]\s*(.*)$/.exec(heading);
      if (dated) {
        if (current) entries.push(current);
        current = { date: dated[1], title: dated[2].trim(), summary: undefined };
        continue;
      }
      current = null;
      continue;
    }

    if (current) {
      const decision = /^\*\*Decision:\*\*\s*(.*)$/.exec(trimmed);
      if (decision) current.summary = decision[1].trim();
    }
  }

  if (current) entries.push(current);
  // Newest decisions are appended at the top of the file.
  return { latest: entries[0] ?? null };
}

// ============================================================================
// parseVision — VISION.md (expand detail only)
// ============================================================================

export function parseVision(md: string): { title: string | null; summary: string } {
  let title: string | null = null;
  const prose: string[] = [];

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = /^#\s+(.*)$/.exec(line);
    if (h && title === null) {
      title = h[1].trim();
      continue;
    }
    if (/^#+\s/.test(line)) continue;
    prose.push(line);
  }

  return { title, summary: prose.join(" ").trim() };
}

// ============================================================================
// Phase derivation
// ============================================================================

function computePhaseFromTasks(
  phases: TasksParse["phases"],
): ProjectState["phase"] {
  if (phases.length === 0) return null;
  const withPending = phases.filter((p) => p.pending > 0).sort((a, b) => a.number - b.number);
  if (withPending.length > 0) {
    const p = withPending[0];
    return { current: p.number, total: phases.length, title: p.title };
  }
  const withDone = phases.filter((p) => p.done > 0).sort((a, b) => b.number - a.number);
  if (withDone.length > 0) {
    const p = withDone[0];
    return { current: p.number, total: phases.length, title: p.title };
  }
  const first = phases[0];
  return { current: first.number, total: phases.length, title: first.title };
}

function computePhaseFromPlan(phases: PlanParse["phases"]): ProjectState["phase"] {
  if (phases.length === 0) return null;
  const hasCompletion = phases.some((p) => p.completion !== null);
  if (!hasCompletion) {
    // Standard `## Phases` list: no per-phase completion tracked.
    return { current: null, total: phases.length };
  }
  const incomplete = phases
    .filter((p) => p.completion === null || p.completion < 100)
    .sort((a, b) => a.number - b.number);
  if (incomplete.length > 0) {
    const p = incomplete[0];
    return { current: p.number, total: phases.length, title: p.title };
  }
  const last = phases[phases.length - 1];
  return { current: last.number, total: phases.length, title: last.title };
}

// ============================================================================
// buildProjectState — compose everything
// ============================================================================

export function buildProjectState(input: ProjectStateInput): ProjectState {
  const sources: ProjectState["sources"] = {
    plan: input.plan === null ? "absent" : "present",
    tasks: input.tasks === null ? "absent" : "present",
    progress: input.progress === null ? "absent" : "present",
    decisions: input.decisions === null ? "absent" : "present",
    vision: input.vision === null ? "absent" : "present",
  };

  const tasksParse = input.tasks !== null ? parseTasks(input.tasks) : null;
  const planParse = input.plan !== null ? parsePlan(input.plan) : null;
  const progressParse = input.progress !== null ? parseProgress(input.progress) : null;
  const decisionsParse = input.decisions !== null ? parseDecisions(input.decisions) : null;

  const phases: PhaseSummary[] = [];
  let phase: ProjectState["phase"] = null;

  if (tasksParse && tasksParse.phases.length > 0) {
    for (const p of tasksParse.phases) {
      phases.push({ number: p.number, title: p.title, done: p.done, pending: p.pending, completion: null });
    }
    phase = computePhaseFromTasks(tasksParse.phases);
  } else if (planParse && planParse.phases.length > 0) {
    for (const p of planParse.phases) {
      phases.push({ number: p.number, title: p.title, done: 0, pending: 0, completion: p.completion });
    }
    phase = computePhaseFromPlan(planParse.phases);
  }

  const blocked = tasksParse ? tasksParse.blocked : null;
  const openQuestions = planParse
    ? { count: planParse.openQuestions.length, items: planParse.openQuestions }
    : null;
  const lastDecision = decisionsParse?.latest ?? null;
  const latestEntry = progressParse?.entries[0];
  const latestProgress = latestEntry
    ? { timestamp: latestEntry.timestamp, summary: latestEntry.summary, body: latestEntry.body }
    : null;

  return {
    phase,
    blocked,
    openQuestions,
    lastDecision,
    movedSince: null, // Phase 4 (deferred)
    phases,
    latestProgress,
    sources,
  };
}

// ============================================================================
// formatProjectStateLine — the collapsed verdict one-liner
// ============================================================================

/**
 * Render the collapsed one-liner from the verdict primitives. Segments are
 * omitted when their source is absent; `blocked` shows "nothing blocked" only
 * when we actually looked (TASKS.md present and count === 0), and open
 * questions appear only when count > 0.
 */
export function formatProjectStateLine(state: ProjectState): string {
  const segments: string[] = [];

  if (state.phase) {
    if (state.phase.current != null) {
      segments.push(`Phase ${state.phase.current}/${state.phase.total}`);
    } else {
      segments.push(`${state.phase.total} phases`);
    }
  }
  if (state.blocked) {
    segments.push(state.blocked.count === 0 ? "nothing blocked" : `${state.blocked.count} blocked`);
  }
  if (state.openQuestions && state.openQuestions.count > 0) {
    segments.push(`${state.openQuestions.count} open Qs`);
  }
  if (state.lastDecision) {
    const text = state.lastDecision.summary || state.lastDecision.title;
    segments.push(`last: ${text}`);
  }
  if (state.movedSince) {
    segments.push(`+${state.movedSince.completedDelta} tasks since ${state.movedSince.sinceLabel}`);
  }

  return segments.join(" · ");
}
