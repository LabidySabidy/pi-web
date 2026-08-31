import { NextResponse } from "next/server";
import { detectKeyword, KwsError } from "@/lib/kws-bridge";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_BASE64_BYTES = 256 * 1024; // ~2s of 16kHz int16, with base64 slack

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { audio?: unknown };
  try {
    body = (await req.json()) as { audio?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const audio = typeof body.audio === "string" ? body.audio : "";
  if (!audio) {
    return NextResponse.json({ error: "audio (base64 PCM) is required" }, { status: 400 });
  }
  if (audio.length > MAX_BASE64_BYTES) {
    return NextResponse.json({ error: "audio chunk too large" }, { status: 400 });
  }

  try {
    const detected = await detectKeyword(audio);
    return NextResponse.json({ detected });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: error instanceof KwsError ? 503 : 500 });
  }
}
