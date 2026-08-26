# Progress

> Rolling session summaries, newest first.







<!-- session-in-progress:start=2026-08-26T21:21:13.786Z -->
## 2026-08-26 16:22 — **Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRES... _(in progress)_
**Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRESS.md`, so the `**` markdown showed as literal stars.
<!-- end-session-in-progress -->
## 2026-08-26 16:15 — **Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRES...
**Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRESS.md`, so the `**` markdown showed as literal stars.
## 2026-08-26 11:21 — **Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRES...
**Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRESS.md`, so the `**` markdown showed as literal stars.
## 2026-08-26 10:34 — **Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRES...
**Changed:**` / `**Verified:**` / `**Next:**` labels come straight from `PROGRESS.md`, so the `**` markdown showed as literal stars.
## 2026-08-26 09:35 — **Changed:** `lib/audio.ts` + test, `hooks/useDictation.ts`, `components/Dictati...
**Changed:** `lib/audio.ts` + test, `hooks/useDictation.ts`, `components/DictationButton.tsx`, `components/DictationLevel.tsx` (new), `components/ChatInput.tsx`.
**Verified:** `tsc` exit 0, `eslint` exit 0, `audio.test.mjs` 5/5, full suite 866/881 with only the 11 known pre-existing failures.
**Next:** Your visual check of the bars + processing indicator; tune gain/bar count if needed.
## 2026-08-26 09:07 — **Changed:** `components/DictationButton.tsx` (recording no longer disables the ...
**Changed:** `components/DictationButton.tsx` (recording no longer disables the button) and `hooks/useDictation.ts` (resume the AudioContext).
**Verified:** `tsc --noEmit` exit 0; `npm run lint` exit 0. Root cause traced to the `disabled={busy}` + missing `resume()`; browser behavior is yours to confirm.
**Next:** Re-test the mic flow in the browser; if text still doesn't appear after stopping, tell me what the mic/tooltip shows and I'll dig into the capture/transcribe path.
## 2026-08-25 22:15 — Whisper dictation in the chat input
**Changed:** Added offline voice dictation to the chat input, backed by the Whisper VTT `whisper-server.exe`: `lib/whisper-server.ts` (spawn/adopt/switch/transcribe bridge + pref file `~/.pi/agent/whisper-vtt.json`), `lib/audio.ts` (WAV encode + 16 kHz resample), `hooks/useDictation.ts`, `components/DictationButton.tsx` (mic toggle + device/model picker), `app/api/whisper/{status,model}` + `app/api/transcribe` routes, `ChatInput.tsx` wiring, i18n keys, and eager spawn in `instrumentation.ts`.
**Verified:** `tsc`/`eslint` exit 0; 880 tests / 865 pass with only the 11 pre-existing failures (+21 new tests green); live against the running dev server — `/api/whisper/status` reports `available`, `POST /api/transcribe` round-trips a WAV → `{"text":""}` (HTTP 200), model switch to `tiny.en` and back persists and re-warms.
**Next:** Your manual check — click the mic in the browser, dictate a real phrase, and confirm the text lands at the cursor (mic capture + real speech can only be verified in-browser, not from the server side).





## 2026-08-25 23:07 — **Changed:**
- `lib/whisper-server.ts` — spawn/adopt/switch/transcribe bridge + ...
**Changed:**
- `lib/whisper-server.ts` — spawn/adopt/switch/transcribe bridge + `~/.pi/agent/whisper-vtt.json` model preference; `lib/audio.ts` (WAV encode + 16 kHz resample)
- `hooks/useDictation.ts` — mic capture (device selection, toggle); `components/DictationButton.tsx` — mic toggle + device/model picker
- `app/api/whisper/status` + `app/api/whisper/model` + `app/api/transcribe` routes; `ChatInput.tsx` wiring; i18n keys (en/zh-CN/zh-TW); `instrumentation.ts` eager spawn
- `PLAN.md`, `TAS...
## 2026-08-25 22:34 — Plan updated for model switching
Plan updated for model switching. Changes from v1:

- **Model discovery**: scan Whisper-VTT `models/` for `ggml-*.bin`/`*.gguf` (finds `base.en` + `tiny.en`)
- **`POST /api/whisper/model`**: validates the name, persists to `~/.pi/agent/whisper-vtt.json` (atomic write, same pattern as `lib/subagent-settings.ts`), restarts the child with the new `-m` flag
- **UI**: model selector alongside the device selector in the dictation controls
- Default stays `base.en`, choice survives restart

Full pla...
## 2026-08-25 22:20 — Plan is written
Plan is written. Summary of what I'll build:

**Backend (lighter path, verified):** Pi Web spawns `whisper-server.exe` — already in your Whisper-VTT repo, loads your existing `ggml-base.en.bin`, serves `POST /inference` → `{"text"}` (spike-confirmed HTTP 200). No Python, no new deps.

**Pi Web side (5 phases):**
1. `lib/whisper-server.ts` — config resolution (env `WHISPER_*` + sibling `../Whisper-VTT` default), spawn/adopt singleton, transcribe, status
2. `app/api/transcribe` + `app/api/whisp...
## 2026-08-25 22:18 — **Changed:** Added `lib/project-state.ts` (+test), `app/api/project/state/route....
**Changed:** Added `lib/project-state.ts` (+test), `app/api/project/state/route.ts` (+test), `hooks/useProjectState.ts`, `components/ProjectStateHeader.tsx`; mounted the header in `ChatWindow.tsx`; updated `PLAN.md`.
**Verified:** `tsc` exit 0, `eslint` exit 0, 25 new tests green, full suite 844/859 with only the 11 pre-existing failures, and real-project one-liners rendered above.
**Next:** Your dev-server look at the actual one-liner on real projects — tell me what to tune (esp. whether `N ...
## 2026-08-25 21:34 — **Changed:** Added `lib/project-state.ts` (+test), `app/api/project/state/route....
**Changed:** Added `lib/project-state.ts` (+test), `app/api/project/state/route.ts` (+test), `hooks/useProjectState.ts`, `components/ProjectStateHeader.tsx`; mounted the header in `ChatWindow.tsx`; updated `PLAN.md`.
**Verified:** `tsc` exit 0, `eslint` exit 0, 25 new tests green, full suite 844/859 with only the 11 pre-existing failures, and real-project one-liners rendered above.
**Next:** Your dev-server look at the actual one-liner on real projects — tell me what to tune (esp. whether `N ...
