# Tasks — Whisper dictation

> Monotonic task IDs for the Whisper dictation feature (see PLAN.md). All complete.

## Phase 1 — Whisper server bridge

- [x] T-001 — `lib/whisper-server.ts` pure helpers (config, model discovery, model choice, status) + `lib/whisper-server.test.mjs`
- [x] T-002 — `lib/whisper-server.ts` singleton (spawn/adopt/switch/transcribe/stop)

## Phase 2 — API routes

- [x] T-003 — `app/api/whisper/status/route.ts` + `app/api/whisper/model/route.ts` (+ `model/route.test.mjs`)
- [x] T-004 — `app/api/transcribe/route.ts` (+ `route.test.mjs`)

## Phase 3 — Dictation hook

- [x] T-005 — `hooks/useDictation.ts` + `lib/audio.ts` (`encodeWav`, `resampleTo16k`) + `lib/audio.test.mjs`

## Phase 4 — UI wiring

- [x] T-006 — `components/DictationButton.tsx` (mic toggle + device/model picker + status)
- [x] T-007 — `components/ChatInput.tsx` wiring (extract `insertText`, mount dictation controls)
- [x] T-008 — i18n keys in `en.ts` / `zh-CN.ts` / `zh-TW.ts`

## Phase 5 — Auto-start

- [x] T-009 — `instrumentation.ts` eager `ensureWhisperServer()`
- [x] T-010 — Full gates + `PROGRESS.md`
