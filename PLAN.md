# Plan — Whisper dictation in Pi Web chat input

## Goal
Add a microphone toggle to the Pi Web chat input that records speech, transcribes it locally via the Whisper VTT `whisper-server.exe`, and inserts the text at the cursor — with a selector to switch among local GGML models.

## Approach
Pi Web spawns `whisper-server.exe` (whisper.cpp's native HTTP server, already built in `Whisper-VTT/whisper-cli/Release/`) at boot and keeps it in a `globalThis` singleton (same HMR-survival pattern as `__piSessions`). The browser captures mic audio via `getUserMedia` + `AudioContext` at 16kHz mono, WAV-encodes it, and POSTs to a new `/api/transcribe` route that proxies to the local server (`POST /inference`, multipart `file`) and returns `{text}`. A new `useDictation` hook drives a mic toggle button in the input bar, with a device selector (`enumerateDevices`). Stop behavior is a click-toggle for v1.

Models are discovered by scanning the Whisper-VTT `models/` dir for `ggml-*.bin`/`*.gguf`. Default is `base.en` (their configured model); switching models persists the choice to `~/.pi/agent/whisper-vtt.json` (atomic write, same pattern as `lib/subagent-settings.ts`) and restarts the child with the new `-m` flag.

Feature is opt-in: config resolves the exe + model dir from env (`WHISPER_VTT_ROOT`, `WHISPER_SERVER_PATH`, `WHISPER_MODEL_DIR`, `WHISPER_PORT`) with a sibling `../Whisper-VTT` default; when absent, status reports `unavailable` and the UI hides the mic button.

## Phases

1. **Whisper server bridge** — `lib/whisper-server.ts`: config resolution, model discovery, preference read/write, spawn/adopt/switch/status/transcribe. Pure helpers (`resolveWhisperConfig`, `deriveStatus`, `resolveModelChoice`) tested.
2. **API routes** — `app/api/whisper/status/route.ts` (GET), `app/api/whisper/model/route.ts` (POST switch), `app/api/transcribe/route.ts` (POST WAV → `{text}`), with graceful 503 when unavailable.
3. **Dictation hook** — `hooks/useDictation.ts`: device enumeration, capture, toggle, `encodeWav` + `resampleTo16k` pure helpers (tested).
4. **UI wiring** — mic toggle + device/model selectors in `ChatInput`; `insertText` on result; status indicator; i18n keys.
5. **Auto-start** — `instrumentation.ts` `register()` calls `ensureWhisperServer()` on boot.

## Files that will change

| File | Change | Phase |
|---|---|---|
| `lib/whisper-server.ts` | NEW — config resolution, model discovery, preference persistence, spawn/adopt/switch singleton, `transcribeWav`, `getWhisperStatus` | 1 |
| `lib/whisper-server.test.mjs` | NEW — config + status + model-choice + error-path tests | 1 |
| `app/api/whisper/status/route.ts` | NEW — GET status + models + currentModel | 2 |
| `app/api/whisper/model/route.ts` | NEW — POST switch model | 2 |
| `app/api/whisper/model/route.test.mjs` | NEW — model-choice validation + unavailable path | 2 |
| `app/api/transcribe/route.ts` | NEW — POST WAV → `{text}` | 2 |
| `app/api/transcribe/route.test.mjs` | NEW — 503 when down, passthrough when up | 2 |
| `hooks/useDictation.ts` | NEW — capture + toggle + `encodeWav`/`resampleTo16k` | 3 |
| `hooks/useDictation.test.mjs` | NEW — WAV header/size + resample tests | 3 |
| `components/ChatInput.tsx` | MODIFY — extract `insertText`, mount dictation controls | 4 |
| `components/DictationButton.tsx` | NEW — mic toggle + device/model picker + status | 4 |
| `lib/i18n/messages/en.ts` (+ zh-CN, zh-TW) | MODIFY — dictation strings | 4 |
| `instrumentation.ts` | MODIFY — eager `ensureWhisperServer()` | 5 |

## Acceptance criteria

- [ ] `GET /api/whisper/status` returns `{available, running, warmingUp, error, models[], currentModel}` and reflects the spawned server
- [ ] `POST /api/whisper/model` with a discovered model name restarts the server on that model and persists it; invalid/unknown name returns 400
- [ ] `POST /api/transcribe` with a WAV returns `{text}` transcribed by whisper.cpp; returns 503 + clear message when the service is down
- [ ] Mic button toggles recording; on stop, transcribed text is inserted at the cursor via `insertText`
- [ ] Device selector lists input mics and records from the chosen one; model selector lists discovered models and switches
- [ ] Selected model survives a Pi Web restart (persisted to `~/.pi/agent/whisper-vtt.json`)
- [ ] On `npm run dev`, `whisper-server.exe` starts automatically and warms up (verified via status endpoint)
- [ ] When Whisper-VTT/exe/model dir are missing, status is `unavailable` and the mic button is hidden (no crash)
- [ ] Gates: `tsc --noEmit` exit 0, `npm run lint` exit 0, `npm test` green (new tests + no regressions). No `next build` (per AGENTS.md).

## Not in scope

VAD auto-stop, wake word, LAN/HTTPS mic (secure-context limit), bundling the model into pi-web, GPU, non-English, downloading new models (switch only among already-present local models), resampling beyond linear.

## Open questions

None.

## References

- `.agent/grill/whisper-dictation.md` — design concept, assumptions, risk ranking
- Whisper VTT: `F:/Development/Whisper-VTT` (`whisper-cli/Release/whisper-server.exe`, `models/ggml-base.en.bin`, `models/ggml-tiny.en.bin`)
