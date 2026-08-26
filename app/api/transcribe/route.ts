import { NextResponse } from "next/server";
import { transcribeWav, WhisperError } from "@/lib/whisper-server";

const MAX_WAV_BYTES = 50 * 1024 * 1024; // 50MB guard

/** True when `bytes` starts with a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 // "WAVE"
  );
}

// POST /api/transcribe — raw WAV body (16kHz mono PCM) → { text }.
export async function POST(req: Request) {
  let wav: Uint8Array;
  try {
    wav = new Uint8Array(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Invalid audio body" }, { status: 400 });
  }

  if (!isWav(wav)) {
    return NextResponse.json({ error: "Expected WAV audio" }, { status: 400 });
  }
  if (wav.byteLength > MAX_WAV_BYTES) {
    return NextResponse.json({ error: "Audio too large" }, { status: 413 });
  }

  try {
    const text = await transcribeWav(wav);
    return NextResponse.json({ text });
  } catch (error) {
    const message = error instanceof WhisperError ? error.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
