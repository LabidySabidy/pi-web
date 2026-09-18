/**
 * Turn lifecycle for Live Conversation mode.
 *
 * Tracks whether the runtime is currently producing events the client should
 * act on. The problem it solves is a race, not a state-tracking nicety.
 *
 * `session.abort()` resolves **before** the runtime's drained `agent_end`
 * reaches subscribers -- the drain happens on a later macrotask. So after a
 * barge-in, the cancelled turn's residual events still arrive: a late
 * `text_delta`, `turn_end` or `agent_end` can bleed into the next turn, playing
 * stale audio or leaving the UI stuck on "thinking" forever.
 *
 * Two constraints fall out, and both were learned the hard way upstream (this
 * mirrors the shape of pi-omni's `turn-lifecycle.ts`, reimplemented here --
 * see PLAN.md references):
 *
 * 1. `end()` must NOT clear `active`. Only `begin()` may replace an active turn.
 *    A stray `end()` that deactivated the new turn would silently drop every
 *    subsequent delta -- the "stuck in thinking" failure.
 *
 * 2. A late drained `agent_end` must be classified and suppressed rather than
 *    forwarded, because the client cannot tell it apart from the current turn's
 *    real completion.
 *
 * Pure and time-free: no timers, no I/O, no React. That makes the race
 * exhaustively testable, which matters because it is timing-dependent in
 * production.
 */

export type EndKind = "natural" | "cancelled" | "idle";

export class TurnLifecycle {
  private active = false;
  /** Stale ends we expect but have not yet seen consumed. */
  private pendingStaleEnds = 0;
  /** Whether the most recent begin() created a stale end (for revert()). */
  private lastBeginAddedStale = false;

  /** True while events from the current turn should be forwarded. */
  get isActive(): boolean {
    return this.active;
  }

  /** Pending stale ends, exposed for tests and diagnostics. */
  get pending(): number {
    return this.pendingStaleEnds;
  }

  /**
   * A new turn starts.
   *
   * If a turn was already active, its end has not arrived yet, so we now expect
   * one stale end and stop forwarding until `rearm()` re-asserts the new turn.
   */
  begin(): void {
    if (this.active) {
      this.pendingStaleEnds += 1;
      this.active = false;
      this.lastBeginAddedStale = true;
    } else {
      this.active = true;
      this.lastBeginAddedStale = false;
    }
  }

  /**
   * The current turn is being cancelled deliberately (barge-in, or an explicit
   * stop). Stop forwarding immediately; the drained end will be suppressed.
   *
   * Uses `cancel()` rather than `end()` so the pending stale end classifies as
   * `cancelled` when it finally arrives.
   */
  cancel(): void {
    if (!this.active) return;
    this.pendingStaleEnds += 1;
    this.active = false;
  }

  /**
   * Re-assert the new turn after a cancel/begin pair, and decay one expected
   * stale end.
   *
   * We wait as long as we reasonably can for the drained end. Forfeiting
   * suppression is the lesser evil: a late drained end classifies as `natural`
   * and is forwarded (harmless, and the frontend guards against a phantom
   * placeholder), whereas keeping it pending would misclassify the *real* end as
   * cancelled and leave the UI stuck in "thinking" permanently.
   */
  rearm(): void {
    this.active = true;
    if (this.pendingStaleEnds > 0) this.pendingStaleEnds -= 1;
  }

  /**
   * Undo the most recent `begin()` -- used when an utterance turns out to be
   * empty after STT, so no turn actually started and no stale end is expected.
   */
  revert(): void {
    if (this.lastBeginAddedStale) {
      this.pendingStaleEnds = Math.max(0, this.pendingStaleEnds - 1);
      this.active = true;
      this.lastBeginAddedStale = false;
    } else {
      this.active = false;
    }
  }

  /**
   * A turn end arrived. Classify it:
   *
   * - `cancelled` -- a stale end we were expecting; suppress it
   * - `natural`   -- the current turn finished; forward it
   * - `idle`      -- nothing was active and nothing pending; ignore it
   *
   * Deliberately does NOT set `active = false` (constraint 1 above).
   */
  end(): EndKind {
    if (this.pendingStaleEnds > 0) {
      this.pendingStaleEnds -= 1;
      return "cancelled";
    }
    if (!this.active) return "idle";
    return "natural";
  }

  /** Reset to the initial state, e.g. when Live mode is turned off. */
  reset(): void {
    this.active = false;
    this.pendingStaleEnds = 0;
    this.lastBeginAddedStale = false;
  }
}
