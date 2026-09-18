/**
 * Minimal ambient types for `@jorastechnologies/silvero-vad-js`, which ships
 * JavaScript without declarations. Only the surface pi-web actually uses is
 * described, so an upstream API change that we depend on shows up as a type
 * error rather than a runtime surprise.
 */
declare module "@jorastechnologies/silvero-vad-js" {
  /** A loaded weight tensor: `data` is a view into the fetched weights buffer. */
  export interface VadTensor {
    shape: number[];
    data: Float32Array;
  }

  export type VadWeights = Record<string, VadTensor>;

  export interface VadManifest {
    tensors: Array<{ name: string; shape: number[]; offset: number; length: number }>;
  }

  /**
   * Pure-JS SileroVAD v5. `process` consumes exactly one 512-sample frame at
   * the model's sample rate and returns a speech probability in 0..1. The model
   * is recurrent, so frames must be fed in order.
   */
  export class SileroVADJS {
    constructor(weights: VadWeights, sampleRate: number);
    process(frame: Float32Array): number;
    reset(): void;
  }

  export function loadWeightsFromBuffers(
    arrayBuffer: ArrayBuffer,
    manifest: VadManifest,
  ): VadWeights;

  export function loadWeights(binUrl: string, manifestUrl: string): Promise<VadWeights>;
}
