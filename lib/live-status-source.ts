/**
 * Snapshot assembly for Live Conversation status reports.
 *
 * Reads live session state and produces the plain object `summariseStatus`
 * speaks about. Kept separate from the phrasing so the wiring can be tested with
 * a fake session rather than a real agent runtime.
 *
 * A status answer must never mutate the conversation. This module only *reads*:
 * no prompt, no steer, no message appended. That property is the reason the
 * middleman can be asked how things are going without interrupting the work.
 */

import type { LiveStatusSnapshot, LiveSubagentSnapshot } from "./live-status";
import type { SubagentSessionStatus } from "./types";

/** The narrow slice of an agent session this module needs. */
export interface StatusSessionLike {
  readonly isStreaming: boolean;
  readonly pendingMessageCount?: number;
  getState?: () => unknown;
  getContextUsage?: () => { percent: number | null } | null | undefined;
  getSteeringMessages?: () => string[];
  getFollowUpMessages?: () => string[];
  isBashRunning?: boolean;
  isCompacting?: boolean;
}

/** The narrow slice of a session listing this module needs. */
export interface SessionInfoLike {
  id: string;
  parentSessionId?: string;
  relation?: {
    kind: string;
    parentSessionId?: string;
    profile?: string;
    description?: string;
    status?: string;
  };
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set<SubagentSessionStatus>([
  "starting",
  "running",
  "completed",
  "failed",
  "aborted",
  "interrupted",
]);

function toStatus(value: string | undefined): SubagentSessionStatus {
  return value && KNOWN_STATUSES.has(value) ? (value as SubagentSessionStatus) : "running";
}

/**
 * Collect background subagent runs belonging to `parentSessionId`.
 *
 * `sessions` is the listing pi-web already computes for the session panel, so
 * this adds no new query -- it only filters what the UI can already see.
 */
export function collectSubagents(
  sessions: SessionInfoLike[],
  parentSessionId: string,
): LiveSubagentSnapshot[] {
  const runs: LiveSubagentSnapshot[] = [];
  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    // Prefer the relation's parent; fall back to the top-level field.
    const parent = session.relation.parentSessionId ?? session.parentSessionId;
    if (parent !== parentSessionId) continue;
    runs.push({
      profile: session.relation.profile ?? "",
      description: session.relation.description ?? "",
      status: toStatus(session.relation.status),
    });
  }
  return runs;
}

/** Safely call an optional accessor; a throwing runtime must not break a status reply. */
function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}

export interface BuildStatusSnapshotInput {
  session: StatusSessionLike;
  sessions?: SessionInfoLike[];
  sessionId: string;
  /** When the current turn started, if known. */
  turnStartedAtMs?: number;
  /** Latest assistant text, for the idle fallback. */
  lastAssistantText?: string;
  /** Injected for tests. */
  now?: number;
}

/** Assemble the snapshot that `summariseStatus` speaks about. */
export function buildStatusSnapshot(input: BuildStatusSnapshotInput): LiveStatusSnapshot {
  const { session, sessions = [], sessionId, turnStartedAtMs, lastAssistantText } = input;
  const now = input.now ?? Date.now();

  const streaming = Boolean(session.isStreaming);
  const elapsed =
    streaming && typeof turnStartedAtMs === "number" && turnStartedAtMs > 0
      ? Math.max(0, now - turnStartedAtMs)
      : undefined;

  const contextUsage = safe(() => session.getContextUsage?.(), null);
  const percent = contextUsage && typeof contextUsage.percent === "number" ? contextUsage.percent : undefined;

  const steering = safe(() => session.getSteeringMessages?.(), []);
  const followUp = safe(() => session.getFollowUpMessages?.(), []);

  return {
    isStreaming: streaming,
    // A pending prompt means work was accepted but has not settled. Treated the
    // same as streaming for description purposes, so a queued prompt does not
    // read as "nothing's running".
    isPromptRunning: streaming || (session.pendingMessageCount ?? 0) > 0,
    isBashRunning: Boolean(session.isBashRunning),
    isCompacting: Boolean(session.isCompacting),
    ...(elapsed !== undefined ? { turnElapsedMs: elapsed } : {}),
    ...(percent !== undefined ? { contextPercent: percent } : {}),
    steeringCount: Array.isArray(steering) ? steering.length : 0,
    followUpCount: Array.isArray(followUp) ? followUp.length : 0,
    subagents: collectSubagents(sessions, sessionId),
    ...(lastAssistantText?.trim() ? { lastAssistantText } : {}),
  };
}
