import { NextResponse } from "next/server";
import { switchWhisperModel, WhisperError } from "@/lib/whisper-server";

// POST /api/whisper/model  body: { model: "ggml-tiny.en.bin" }
// Validates against discovered local models, persists the choice, and restarts
// the whisper server on it. Returns the fresh status (warmingUp = true).
export async function POST(req: Request) {
  let model: unknown;
  try {
    ({ model } = await req.json() as { model?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const status = await switchWhisperModel(model);
    return NextResponse.json(status);
  } catch (error) {
    const message = error instanceof WhisperError ? error.message : "Failed to switch model";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
