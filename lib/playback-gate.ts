/**
 * Playback arbitration for Live Conversation mode.
 *
 * Decides which audio is allowed to be heard, so that a barge-in silences
 * speech already in flight and a stop racing a natural end cannot fire
 * completion twice. The WebAudio wiring lives in `useLivePlayer`; this holds the
 * rules, which is the part with the races in it.
 *
 * Pure and time-free, so the two bugs worth preventing are testable:
 *
 * 1. **Double completion.** `stop()` settles the in-flight promise, and the
 *    browser's `onended` fires shortly after. Without a guard, `onEnd` runs
 *    twice per utterance -- once for the interruption and once for the audio
 *    that was interrupted.
 *
 * 2. **Stale generation winning.** A replace (`play` while playing) must
 *    discard the previous utterance's pending completion. If it did not, a late
 *    end from the old audio would clear the new utterance's playing state.
 */

export type PlaybackEvent = "start" | "end";

export class PlaybackGate {
  /** Incremented on every replace or stop; stale closures compare against it. */
  private generation = 0;
  private active = false;
  private settledGeneration = -1;

  get isActive(): boolean {
    return this.active;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /**
   * Begin a new utterance, superseding any current one.
   * Returns the generation token the caller must pass back to `finish`.
   */
  begin(): number {
    // Superseding an active utterance means any pending completion for it is
    // now stale, so the generation moves without announcing an end.
    this.generation += 1;
    this.active = true;
    return this.generation;
  }

  /**
   * The browser reports the audio finished. Only the current generation may
   * complete, and only once.
   */
  finish(token: number): PlaybackEvent | null {
    if (token !== this.generation) return null; // superseded
    if (this.settledGeneration === this.generation) return null; // already done
    this.settledGeneration = this.generation;
    this.active = false;
    return "end";
  }

  /**
   * Audio was interrupted. Returns whether an end should be announced: a
   * completion already reported for this generation must not be repeated.
   */
  stop(): PlaybackEvent | null {
    const wasActive = this.active;
    this.generation += 1;
    this.active = false;
    if (!wasActive) return null;
    this.settledGeneration = this.generation - 1;
    return "end";
  }
}
