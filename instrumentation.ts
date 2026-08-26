export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Eagerly start the local whisper server so dictation is ready when the UI
  // first asks for it (the model load takes ~10-20s on CPU). No-op when the
  // Whisper VTT checkout / models are absent.
  const { ensureWhisperServer } = await import("@/lib/whisper-server");
  void ensureWhisperServer().catch(() => {});
}
