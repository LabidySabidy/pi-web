import { NextResponse } from "next/server";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { synthesizeSpeech, PiperError } from "@/lib/piper-tts";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const SUMMARIZER_PROVIDER = "deepseek";
const SUMMARIZER_MODEL = "deepseek-v4-flash";
const MAX_INPUT_CHARS = 50_000;

/** Build the plain-spoken condensation prompt for the summarizer. */
export function buildSummarizePrompt(text: string): string {
  return [
    "You are turning a written answer into a short spoken summary.",
    "Rewrite the message below as 2-3 natural, conversational sentences — what a person would actually say out loud.",
    "Plain prose only: no markdown, no backticks, no lists, no code, no emoji.",
    "Expand acronyms. Lead with the outcome, then the single most useful thing to know.",
    "",
    "Message:",
    text,
  ].join("\n");
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function summarizeForSpeech(text: string): Promise<string> {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(SUMMARIZER_PROVIDER, SUMMARIZER_MODEL);
  if (!model) {
    throw new Error(`Summarizer model not found: ${SUMMARIZER_PROVIDER}/${SUMMARIZER_MODEL}`);
  }
  const resolved = await modelRuntime.getAuth(model);
  if (!resolved?.auth.apiKey) {
    throw new Error(`No API key configured for "${SUMMARIZER_PROVIDER}"`);
  }

  const message = await completeSimple(model, {
    messages: [{ role: "user", content: buildSummarizePrompt(text), timestamp: Date.now() }],
  }, {
    apiKey: resolved.auth.apiKey,
    headers: resolved.auth.headers,
    maxTokens: 400,
    timeoutMs: 30_000,
    maxRetries: 0,
    cacheRetention: "none",
  });

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? "Summarization failed");
  }
  const summary = getAssistantText(message).trim();
  if (!summary) throw new Error("Summarization returned empty text");
  return summary;
}

/** Summarize the latest output into speech and return it as a WAV. */
export async function speakText(text: string, voice?: string): Promise<Uint8Array> {
  const summary = await summarizeForSpeech(text);
  return synthesizeSpeech(summary, voice);
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { text?: unknown; voice?: unknown };
  try {
    body = (await req.json()) as { text?: unknown; voice?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return NextResponse.json({ error: `text exceeds ${MAX_INPUT_CHARS} characters` }, { status: 400 });
  }
  const voice = typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : undefined;

  try {
    const wav = await speakText(text, voice);
    return new NextResponse(wav as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof PiperError ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
