import { NextResponse } from "next/server";
import { getPiperStatus } from "@/lib/piper-tts";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const status = getPiperStatus();
  return NextResponse.json({
    voices: status.voices,
    defaultVoice: status.defaultVoice,
    available: status.available,
  });
}
