/**
 * Spoken progress reports for Live Conversation mode.
 *
 * Turns live session state into one or two sentences a person would say out
 * loud. This is what makes the "middleman" useful: the user can ask "how's it
 * going?" and get an answer drawn from real state **without a message being
 * appended to the conversation** and without an agent turn being started.
 *
 * Pure by design -- no I/O, no SDK, no fetch. The caller assembles a snapshot;
 * this decides what to say about it. That keeps the phrasing and the
 * edge cases (nothing running, subagents failed, context nearly full) testable.
 */

import type { SubagentSessionStatus } from "./types";

/** Mirrors `SubagentStatus` in `subagents.ts`, kept structural so this module
 * does not pull the subagent machinery (and its filesystem imports) into a
 * pure summariser. */
export type LiveSubagentStatus = SubagentSessionStatus;

export interface LiveSubagentSnapshot {
  profile: string;
  /** Short activity label shown in the UI. */
  description: string;
  status: LiveSubagentStatus;
  /** Wall-clock ms since the run started. */
  elapsedMs?: number;
}

export interface LiveStatusSnapshot {
  /** A turn is streaming right now. */
  isStreaming: boolean;
  /** A prompt has been accepted but the run has not settled. */
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  /** How long the current turn has been running, when known. */
  turnElapsedMs?: number;
  /** Context window pressure, when known. */
  contextPercent?: number;
  /** Queued messages: already accepted, not yet delivered. */
  steeringCount?: number;
  followUpCount?: number;
  /** Background subagent runs belonging to this session. */
  subagents?: LiveSubagentSnapshot[];
  /** Latest assistant text, used as a fallback description of the work. */
  lastAssistantText?: string;
}

/** Compact duration for speech: "8 seconds", "2 minutes", "an hour". */
export function speakDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Join phrases into a spoken list: "a, b and c". */
function spokenList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const ACTIVE_STATUSES: ReadonlySet<LiveSubagentStatus> = new Set<LiveSubagentStatus>([
  "starting",
  "running",
]);

/**
 * One short description of what the session is doing right now.
 * Returns null when nothing is happening.
 */
export function describeActivity(snapshot: LiveStatusSnapshot): string | null {
  if (snapshot.isCompacting) return "tidying up its context";
  if (snapshot.isBashRunning) return "running a shell command";
  if (snapshot.isStreaming || snapshot.isPromptRunning) {
    const elapsed =
      typeof snapshot.turnElapsedMs === "number" ? ` for ${speakDuration(snapshot.turnElapsedMs)}` : "";
    return `working${elapsed}`;
  }
  return null;
}

/**
 * Build a spoken status report.
 *
 * Written to be *spoken*: no markdown, no lists, no file paths read aloud.
 *
 * Length is budgeted rather than truncated. Slicing the sentence list would
 * silently drop whatever came last -- and failures are appended last, so a
 * blind cap could report a run as healthy while a helper had died. Instead the
 * budget is spent in priority order: what is happening, then anything that went
 * wrong, then helpers, then warnings.
 */
export function summariseStatus(snapshot: LiveStatusSnapshot): string {
  const subagents = snapshot.subagents ?? [];
  const active = subagents.filter((s) => ACTIVE_STATUSES.has(s.status));
  const completed = subagents.filter((s) => s.status === "completed");
  const failed = subagents.filter((s) => s.status === "failed" || s.status === "interrupted");
  const activity = describeActivity(snapshot);

  const parts: string[] = [];

  if (activity) parts.push(`I'm ${activity}.`);

  if (active.length > 0) {
    // Describe helpers by their label, not their profile id, so it sounds like
    // English rather than configuration.
    const labels = active.map((s) => describeSubagent(s)).filter(Boolean);
    parts.push(
      active.length === 1
        ? `One helper is still going: ${labels[0]}.`
        : `${active.length} helpers are still going: ${spokenList(labels)}.`,
    );
  }

  if (completed.length > 0) {
    parts.push(
      completed.length === 1
        ? `One helper finished: ${describeSubagent(completed[0])}.`
        : `${completed.length} helpers finished.`,
    );
  }

  if (failed.length > 0) {
    // Failures lead with the problem, and are never dropped: reporting that a
    // run is ongoing while a helper died is worse than a long sentence.
    parts.push(
      failed.length === 1
        ? `One helper didn't finish cleanly: ${describeSubagent(failed[0])}.`
        : `${failed.length} helpers didn't finish cleanly.`,
    );
  }

  const queued = (snapshot.steeringCount ?? 0) + (snapshot.followUpCount ?? 0);
  const contextFull =
    typeof snapshot.contextPercent === "number" && snapshot.contextPercent >= 80
      ? `Heads up, my context is about ${Math.round(snapshot.contextPercent)} percent full.`
      : null;

  const nothingHappening =
    !activity && active.length === 0 && completed.length === 0 && failed.length === 0;

  if (nothingHappening) {
    // Nothing to report: describe the last thing said, or admit there is
    // nothing rather than inventing progress.
    const last = snapshot.lastAssistantText?.trim();
    const summary = last ? firstSentences(last, 1) : "";
    parts.push(summary ? `Last thing I said: ${summary}` : "Nothing's running right now.");
  }

  if (queued > 0) {
    parts.push(queued === 1 ? "One message is queued." : `${queued} messages are queued.`);
  }
  if (contextFull) parts.push(contextFull);

  // Budget in priority order. Everything above is already ordered by importance,
  // so dropping from the end only ever discards queued/context asides.
  const MAX_SENTENCES = 3;
  const kept: string[] = [];
  for (const part of parts) {
    // A failure is always spoken, even if the budget is otherwise spent.
    const isFailureReport = part.includes("didn't finish cleanly");
    if (kept.length >= MAX_SENTENCES && !isFailureReport) continue;
    kept.push(part);
  }

  return kept.join(" ") || "Nothing's running right now.";
}

/** A short spoken label for one subagent run. */
export function describeSubagent(run: LiveSubagentSnapshot): string {
  const description = run.description?.trim();
  if (description) return stripTrailingPunctuation(description);
  const profile = run.profile?.trim();
  if (profile) return profile.replace(/[-_]/g, " ");
  return "a helper";
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.:;,\s]+$/, "");
}

/**
 * Take the first `count` sentences, bounded in length.
 *
 * The assistant's last message can be arbitrarily long; a spoken status must
 * stay short, and truncating mid-sentence sounds broken.
 */
export function firstSentences(text: string, count: number, maxChars = 240): string {
  const normalised = text
    .replace(/```[\s\S]*?```/g, " ") // code blocks are not speakable
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[#*_>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return "";

  const sentences = normalised.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [normalised];
  let out = "";
  for (const sentence of sentences.slice(0, count)) {
    const next = (out ? `${out} ` : "") + sentence.trim();
    if (out && next.length > maxChars) break;
    out = next;
  }
  if (!out) return "";
  return out.length > maxChars ? `${out.slice(0, maxChars).trimEnd()}…` : out;
}
