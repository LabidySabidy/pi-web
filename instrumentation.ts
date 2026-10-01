export async function register(): Promise<void> {
  // Next builds this file for both the Node and the Edge instrumentation entry.
  // The Edge graph rejects Node APIs, so `process.on` and undici live in
  // ./instrumentation-node, reached only through this compile-time-eliminated
  // NEXT_RUNTIME branch. An early `return` instead of this `if` would leave the
  // Node calls in the Edge module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    registerNodeInstrumentation();

    // Eagerly start the local whisper server so dictation is ready when the UI
    // first asks for it (the model load takes ~10-20s on CPU). No-op when the
    // Whisper VTT checkout / models are absent.
    //
    // Kept INSIDE the nodejs branch rather than behind its own early return: the Edge
    // module must not see the import at all. `configureHttpDispatcher` is no longer
    // called from here — it moved into registerNodeInstrumentation() above.
    const { ensureWhisperServer } = await import("@/lib/whisper-server");
    void ensureWhisperServer().catch(() => {});
  }
}
