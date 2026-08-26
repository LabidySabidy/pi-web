# Design Concept — Whisper dictation in Pi Web

## Goal
Add a microphone option to the Pi Web chat input that transcribes speech locally via the Whisper VTT whisper.cpp engine and inserts the text at the cursor.

## Approach
Browser captures mic audio (getUserMedia + AudioContext, 16kHz mono → WAV), POSTs it to a new Pi Web route `/api/transcribe`, which proxies to `whisper-server.exe` (whisper.cpp's native HTTP server, already built in `Whisper-VTT/whisper-cli/Release/`). Pi Web spawns that server on boot. Text returns and is inserted into the input. Stop behavior = click-toggle (v1). Local models are discovered from the Whisper-VTT `models/` dir and switchable via a selector; the choice persists to `~/.pi/agent/whisper-vtt.json` and restarts the child with the new `-m`.

## Assumptions (with confidence)
- HIGH: `whisper-server.exe` is lighter than a Python bridge (no Python runtime, ~4MB binaries + shared model). Verified by spike: loads `ggml-base.en.bin` and serves `POST /inference` → `{"text":""}` HTTP 200.
- HIGH: Browser mic capture works on `127.0.0.1` (secure context). `npm run dev` binds 127.0.0.1. LAN/`dev:lan` mic requires HTTPS — out of scope.
- MEDIUM: `new AudioContext({sampleRate:16000})` honors the rate in Chrome/Edge/Firefox. Mitigated by a client-side linear resample fallback if `ctx.sampleRate !== 16000`.
- MEDIUM: whisper.cpp server has no health endpoint; readiness is derived from spawn state + TCP connect to the port.
- LOW: AudioWorklet vs ScriptProcessorNode — ScriptProcessorNode is deprecated but sufficient for v1 (toggle, short utterances).

## Risks (ranked)
- HIGH: wrong sample rate silently produces garbage transcription → client resamples to 16k and tests the resampler + WAV encoder.
- HIGH: orphaned whisper-server.exe holding the port across dev-server restarts → `ensureWhisperServer()` probes the port first and adopts an already-serving process instead of double-spawning.
- MEDIUM: hard dependency on Whisper-VTT repo layout breaks npm consumers → feature is opt-in; if exe/model aren't found, status reports `unavailable` and the UI hides the mic button. Env overrides (`WHISPER_VTT_ROOT`, `WHISPER_SERVER_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_PORT`) + sibling `../Whisper-VTT` default for this machine.
- MEDIUM: model warmup ~10–20s on CPU → eager spawn at boot (instrumentation `register()`), status surfaces `warmingUp`.
- LOW: getUserMedia permission denied → surfaced as an error state on the mic button.

## Out of scope
VAD auto-stop (toggle only), wake word, LAN/HTTPS mic, bundling the model into pi-web, GPU, non-English (base.en is English-only).

## Open questions
None — resolved: default `base.en`, switchable among discovered local models.

## Ready to implement?
Yes.
