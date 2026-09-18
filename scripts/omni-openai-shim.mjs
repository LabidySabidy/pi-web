#!/usr/bin/env node
/**
 * Omni OpenAI-compatible shim.
 *
 * pi-omni (npm:@khimaros/pi-omni) talks to a single OpenAI-compatible speech
 * endpoint (PI_VOICE_BASE_URL) for both STT and TTS. pi-web already runs two
 * local speech servers, but neither speaks the OpenAI shape:
 *
 *   whisper-server  :8765  POST /inference         (multipart, field "file") -> {text}
 *   piper           :8766  POST /synthesize        (json {text,voice})       -> WAV bytes
 *
 * This shim presents the OpenAI surface pi-omni expects and forwards to them:
 *
 *   POST /v1/audio/transcriptions   multipart "file"                        -> {text}
 *   POST /v1/audio/speech           {input,model,voice,response_format}     -> WAV bytes
 *
 * Deliberately no summarization here: pi-omni's voice persona already answers
 * in short conversational sentences. The point of this run is to evaluate the
 * conversational loop, not the summarizer.
 *
 * Zero dependencies (node:http only). Usage:
 *   node scripts/omni-openai-shim.mjs [--port 8080]
 */

import { createServer } from "node:http";

const WHISPER_URL = process.env.SHIM_WHISPER_URL || "http://127.0.0.1:8765";
const WHISPER_PATH = process.env.SHIM_WHISPER_PATH || "/inference";
const PIPER_URL = process.env.SHIM_PIPER_URL || "http://127.0.0.1:8766";
const PIPER_PATH = process.env.SHIM_PIPER_PATH || "/synthesize";
const DEFAULT_VOICE = process.env.SHIM_PIPER_VOICE || "en_US-lessac-medium";
// Piper's medium voices are 22050 Hz. Must match PI_VOICE_TTS_SAMPLE_RATE in
// omni.json or every utterance plays back at the wrong pitch and speed.
const TTS_SAMPLE_RATE = Number.parseInt(process.env.SHIM_TTS_SAMPLE_RATE || "22050", 10);

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number.parseInt(argValue("--port", process.env.SHIM_PORT || "8080"), 10);

function log(...args) {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`${stamp}  ${args.join(" ")}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Re-encode a parsed multipart part as its own multipart body for whisper-server. */
function rebuildMultipart(filename, contentType, data) {
  const boundary = `----shim${Date.now().toString(16)}`;
  const prelude = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    boundary,
    body: Buffer.concat([prelude, data, epilogue]),
  };
}

/** Minimal multipart/form-data parser — extracts the first "file" part. */
function parseMultipartFile(buf, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || "");
  const boundary = (m?.[1] || m?.[2] || "").trim();
  if (!boundary) return null;

  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const start = idx + delim.length;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    parts.push(buf.subarray(start, next));
    idx = next;
  }

  for (const raw of parts) {
    // A part is: \r\n<headers>\r\n\r\n<body>\r\n
    let part = raw;
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    // strip the trailing CRLF that precedes the next boundary
    const trimmed = body.length >= 2 ? body.subarray(0, body.length - 2) : body;

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    if (!nameMatch || nameMatch[1] !== "file") continue;
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    return {
      filename: fileMatch?.[1] || "audio.wav",
      contentType: typeMatch?.[1]?.trim() || "audio/wav",
      data: trimmed,
    };
  }
  return null;
}

/** POST /v1/audio/transcriptions */
async function handleTranscriptions(req, res) {
  const ct = req.headers["content-type"] || "";
  const raw = await readBody(req);
  log(`STT  <- ${raw.length} bytes`);

  let file;
  if (ct.includes("multipart/form-data")) {
    file = parseMultipartFile(raw, ct);
    if (!file) {
      log("STT  !! no 'file' part found");
      return sendJson(res, 400, { error: { message: "no 'file' part in multipart body" } });
    }
  } else {
    file = { filename: "audio.wav", contentType: ct || "audio/wav", data: raw };
  }

  const { boundary, body } = rebuildMultipart(file.filename, file.contentType, file.data);
  let upstream;
  try {
    upstream = await fetch(`${WHISPER_URL}${WHISPER_PATH}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
  } catch (e) {
    log(`STT  !! whisper unreachable: ${e.message}`);
    return sendJson(res, 502, { error: { message: `whisper-server unreachable: ${e.message}` } });
  }

  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    log(`STT  !! whisper ${upstream.status} ${t.slice(0, 160)}`);
    return sendJson(res, 502, { error: { message: `whisper-server ${upstream.status}` } });
  }

  const data = await upstream.json().catch(() => ({}));
  const text = typeof data.text === "string" ? data.text.replace(/\[BLANK_AUDIO\]/gi, "").trim() : "";
  log(`STT  -> ${JSON.stringify(text)}`);
  return sendJson(res, 200, { text });
}

/**
 * Parse a RIFF/WAVE buffer into {sampleRate, channels, bitsPerSample, pcm}.
 * Returns null when the buffer is not a WAV, so callers can pass raw PCM through.
 *
 * pi-omni requests response_format:"pcm" (bare S16_LE). Piper emits a WAV, so
 * the container has to be stripped — handing back the 44-byte header would be
 * played as a burst of garbage samples. Chunks are walked rather than assuming
 * a fixed 44-byte header, because the fmt chunk can be extended.
 */
function parseWav(buf) {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let fmt = null;
  let pcm = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buf.length) break;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      pcm = buf.subarray(start, start + size);
    }
    offset = start + size + (size % 2); // chunks are word-aligned
  }
  if (!pcm || !fmt) return null;
  return { ...fmt, pcm };
}

/** POST /v1/audio/speech */
async function handleSpeech(req, res) {
  const raw = await readBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: { message: "invalid JSON body" } });
  }

  const input = typeof parsed.input === "string" ? parsed.input.trim() : "";
  if (!input) return sendJson(res, 400, { error: { message: "input is required" } });

  // pi-omni passes ttsVoice from config; map anything we don't have to default.
  const voice = typeof parsed.voice === "string" && parsed.voice.trim() ? parsed.voice.trim() : DEFAULT_VOICE;
  log(`TTS  <- ${JSON.stringify(input.slice(0, 70))}${input.length > 70 ? "…" : ""} (voice=${voice})`);

  let upstream;
  try {
    upstream = await fetch(`${PIPER_URL}${PIPER_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input, voice }),
    });
  } catch (e) {
    log(`TTS  !! piper unreachable: ${e.message}`);
    return sendJson(res, 502, { error: { message: `piper unreachable: ${e.message}` } });
  }

  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    log(`TTS  !! piper ${upstream.status} ${t.slice(0, 160)}`);
    return sendJson(res, 502, { error: { message: `piper ${upstream.status}` } });
  }

  const upstreamBuf = Buffer.from(await upstream.arrayBuffer());
  const wav = parseWav(upstreamBuf);
  // Default to bare PCM: that is what the OpenAI TTS API returns for
  // response_format:"pcm", and what pi-omni's streaming player consumes.
  const wantWav = String(parsed.response_format || "").toLowerCase() === "wav";

  let payload = upstreamBuf;
  let contentType = "audio/wav";
  if (wav && !wantWav) {
    payload = wav.pcm;
    contentType = "audio/pcm";
    if (wav.sampleRate !== TTS_SAMPLE_RATE) {
      log(
        `TTS  !! sample rate ${wav.sampleRate} != PI_VOICE_TTS_SAMPLE_RATE ${TTS_SAMPLE_RATE} ` +
          `-- audio will play at the wrong speed; align them.`,
      );
    }
  }

  log(
    `TTS  -> ${payload.length} bytes ${contentType}` +
      (wav ? ` (${wav.sampleRate} Hz ${wav.channels}ch ${wav.bitsPerSample}bit)` : ""),
  );
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [
        { id: "whisper-1", object: "model", owned_by: "local" },
        { id: "tts-1", object: "model", owned_by: "local" },
      ],
    });
  }

  if (req.method === "POST" && path === "/v1/audio/transcriptions") {
    return void handleTranscriptions(req, res).catch((e) => {
      log(`STT  !! ${e.stack || e.message}`);
      sendJson(res, 500, { error: { message: String(e.message) } });
    });
  }

  if (req.method === "POST" && path === "/v1/audio/speech") {
    return void handleSpeech(req, res).catch((e) => {
      log(`TTS  !! ${e.stack || e.message}`);
      sendJson(res, 500, { error: { message: String(e.message) } });
    });
  }

  log(`??  ${req.method} ${path}`);
  sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`shim listening on http://127.0.0.1:${PORT}/v1`);
  log(`  STT -> ${WHISPER_URL}${WHISPER_PATH}`);
  log(`  TTS -> ${PIPER_URL}${PIPER_PATH} (default voice ${DEFAULT_VOICE})`);
});
