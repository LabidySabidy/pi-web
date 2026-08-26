import { NextResponse } from "next/server";
import { ensureWhisperServer } from "@/lib/whisper-server";

// GET /api/whisper/status — current dictation-service state. Idempotent: also
// ensures the server is spawned so Pi Web's first open starts it (belt-and-
// suspenders alongside instrumentation's eager spawn).
export async function GET() {
  const status = await ensureWhisperServer();
  return NextResponse.json(status);
}
