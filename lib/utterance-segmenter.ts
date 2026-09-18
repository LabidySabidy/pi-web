/**
 * Utterance segmentation state machine, extracted from the capture hook so the
 * decision logic is testable without a browser, an AudioContext, or a model.
 *
 * The hook owns the mic and the VAD model; this owns *when an utterance begins
 * and ends*. Keeping them apart means the part with off-by-one and threshold
 * bugs is the part covered by tests.
 */

export interface SegmenterOptions {
  /** Speech probability at or above which a frame counts as speech. */
  threshold: number;
  /** Trailing silence (ms) that closes an utterance. */
  silenceMs: number;
  /** Utterances shorter than this are dropped as noise. */
  minSpeechMs: number;
  /** Hard cap, so a stuck-open gate cannot accumulate without bound. */
  maxUtteranceMs: number;
  /** Frame length in samples, used to convert ms windows into frame counts. */
  frameSamples: number;
  sampleRate: number;
}

export interface CapturedUtterance {
  audio: Float32Array;
  sampleRate: number;
  durationMs: number;
}

export type SegmenterEvent =
  | { type: "speech-start" }
  | { type: "speech-end"; utterance: CapturedUtterance }
  | { type: "discarded"; reason: "too-short" };

export function framesForMs(ms: number, sampleRate: number, frameSamples: number): number {
  if (ms <= 0) return 0;
  return Math.ceil((ms / 1000) * (sampleRate / frameSamples));
}

/**
 * Accumulates frames while speech is detected, closes the utterance after
 * enough trailing silence, and discards anything too short to be speech.
 *
 * `now` is injected so the max-utterance cap is testable without real time.
 */
export class UtteranceSegmenter {
  private readonly options: SegmenterOptions;
  private readonly silenceFrames: number;
  private readonly maxFrames: number;

  private active = false;
  private frames: Float32Array[] = [];
  private silent = 0;
  private startedAt: number | null = null;
  /** Frames captured while speech is not active (kept for pre-roll). */
  private preroll: Float32Array[] = [];

  constructor(options: SegmenterOptions) {
    this.options = options;
    this.silenceFrames = Math.max(1, framesForMs(options.silenceMs, options.sampleRate, options.frameSamples));
    this.maxFrames = Math.max(1, framesForMs(options.maxUtteranceMs, options.sampleRate, options.frameSamples));
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Feed one VAD frame. Returns the events it caused (usually none).
   *
   * The trailing-silence frames are retained so the recorded utterance does not
   * clip the decay of the final word.
   */
  push(frame: Float32Array, probability: number, now: number): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    const isSpeech = probability >= this.options.threshold;

    if (isSpeech) {
      if (!this.active) {
        this.active = true;
        this.startedAt = now;
        // Prepend any preroll so the onset is not clipped either.
        this.frames = [...this.preroll];
        this.preroll = [];
        events.push({ type: "speech-start" });
      }
      this.silent = 0;
      this.frames.push(frame);
    } else if (this.active) {
      this.frames.push(frame);
      this.silent += 1;
      if (this.silent >= this.silenceFrames) {
        const closed = this.close(now);
        events.push(closed);
      }
    } else {
      // Idle: maintain a short preroll so a hard onset is not clipped.
      this.preroll.push(frame);
      const maxPreroll = Math.max(1, Math.ceil(this.silenceFrames / 2));
      if (this.preroll.length > maxPreroll) this.preroll.shift();
    }

    // Hard cap: close even mid-speech so a stuck gate cannot grow unbounded.
    if (this.active && this.frames.length >= this.maxFrames) {
      events.push(this.close(now));
    }

    return events;
  }

  /** Close the current utterance, or report a discard when it is too short. */
  private close(now: number): SegmenterEvent {
    const frames = this.frames;
    const startedAt = this.startedAt;
    this.active = false;
    this.frames = [];
    this.silent = 0;
    this.startedAt = null;

    const total = frames.reduce((n, f) => n + f.length, 0);
    const durationMs = startedAt === null ? 0 : now - startedAt;
    const minMs = this.options.minSpeechMs;
    // Speech duration excludes the trailing silence we deliberately retained.
    const speechMs = total > 0 ? (total / this.options.sampleRate) * 1000 : 0;

    if (total === 0 || speechMs < minMs) {
      return { type: "discarded", reason: "too-short" };
    }

    const audio = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) {
      audio.set(frame, offset);
      offset += frame.length;
    }
    return {
      type: "speech-end",
      utterance: { audio, sampleRate: this.options.sampleRate, durationMs },
    };
  }

  /** Drop any partial utterance, e.g. because playback is starting. */
  reset(): void {
    this.active = false;
    this.frames = [];
    this.silent = 0;
    this.startedAt = null;
    this.preroll = [];
  }
}
