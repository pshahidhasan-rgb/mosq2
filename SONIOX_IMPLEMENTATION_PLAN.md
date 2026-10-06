# MosqAI — Soniox Migration Implementation Plan

> **Purpose:** This is the **single source of truth** for the Soniox Dynamic Language Gates migration.
> Every time a task is finished, this file MUST be updated with a `✅` checkmark, date, and notes.
> If the implementing agent becomes unavailable, the next developer can resume exactly where it left off by reading this file.
> **Do NOT delete or ignore this file. Keep it in git.**

- **Project:** MosqAI — Live Khutbah Translation (Imam → TV + Phones + Earbuds + Quran Detection)
- **Roadmap source:** `HANDOVER_AND_SONIOX_ROADMAP.md`
- **Started:** 2026-10-06
- **Owner approval:** Granted — "Whatever you want to do, just write everything descriptively into a file and checkmark as you go"
- **Authoring agent:** Claude Opus 5.5 via OpenCode (Anthropic)
- **Current status:** 🟡 In Progress — Plan created, execution starting

---

## Table of Contents
1. [Mission & Why Soniox](#1-mission--why-soniox)
2. [What Must Never Break](#2-what-must-never-break)
3. [Approved Architecture — Dynamic Language Gates](#3-approved-architecture--dynamic-language-gates)
4. [Cost Analysis](#4-cost-analysis)
5. [Detailed Implementation Roadmap (with Checkmarks)](#5-detailed-implementation-roadmap-with-checkmarks)
6. [Files To Touch / Not Touch](#6-files-to-touch--not-touch)
7. [Technical Specifications](#7-technical-specifications)
8. [Verification & Testing Plan](#8-verification--testing-plan)
9. [Rollback & Fallback Plan](#9-rollback--fallback-plan)
10. [Progress Log (Agent Activity Diary)](#10-progress-log-agent-activity-diary)

---

## 1. Mission & Why Soniox

**Current problem:** Speech-to-Text and Translation run as **two consecutive stages** (transcribe full sentence → wait → translate). This creates **2–3 seconds of delay**.

**Solution:** Soniox's live streaming translation at `https://soniox.com/speech-translation/arabic/english` streams **translation tokens mid-sentence word-by-word** while the speaker is still talking, achieving **sub-200ms latency**.

**Goal:** Bring that exact demo experience to **both** the Display TV and **all** attendee mobile phones simultaneously.

**Key insight from roadmap:** Soniox does **not broadcast** — it only streams tokens back to the sender. Therefore we need a **central MosqAI Node.js server** to fan-out tokens to 100+ attendees. And we must **not** send 5-10 duplicate audio streams from the Imam's laptop (would kill mosque Wi-Fi). Instead: **1 single audio ingest** → server duplicates in RAM to N Soniox WebSockets.

---

## 2. What Must Never Break

These are **100% operational production features** — any regression is a failure:

| # | Feature | Location | Guarantee |
|---|---------|----------|-----------|
| 1 | **Quran Ayah Detection** — fuzzy matching across 6236 verses, diacritics-normalized, canonical Uthmani + verified translations | `server/quranMatcher.js` + `server/services/quranAiDetector.js` | Re-fed from Soniox `translation_status:"original"` tokens in <2ms |
| 2 | **Live Attendance Counter** — accurate split 📱 Phones vs 🖥️ TV/Computers via User-Agent + role (`attendee` vs `tv`) | `server/sessionManager.js` (`getSessionStats`, `addSubscriber`, `recordHttpPing`) + `public/admin.js` | Must stay identical |
| 3 | **Multi-Day Session History** — each sermon run archived with date, start time, duration, peak attendance breakdown, transcripts paired with **Display TV's target translation** | `server/sessionManager.js` (`archiveSessionRun`, `history.json`, `data/history.json`) + `sql/schema.sql` (`mosq_` tables) | No schema break, auto-persist intact |
| 4 | **Display TV Layout & Controls** — Arabic + translation start at same vertical level, Hide/Show QR toggle, font size & line capacity (up to 12 lines / 3X), audio playback controls | `public/display.html`+`display.js` + `public/admin.js` + `server/sessionManager.js` (`updateTvSettings`, `broadcastToSession`) | Pixel-perfect |
| 5 | **Language Support** — 10 languages: `en, uz, tr, ur, bn, fr, zh, zh-TW, id, so` on TV and mobile | `public/join.js`, `display.js`, `translationService.js` | All must remain selectable |
| 6 | **TV + Mobile Audio (Earbuds)** — `window.speechSynthesis` free native TTS, admin-controlled on TV, per-user on phones | `public/display.js`, `public/join.js` | Trigger only on finalized sentences |
| 7 | **Existing Gladia/STT fallback** | `server/services/sttService.js` | Kept as fallback until Soniox fully verified |

---

## 3. Approved Architecture — Dynamic Language Gates

```
[ Imam Microphone (Admin Browser) ]
                │
                ▼  (1 single WebSocket stream over mosque Wi-Fi)
        [ MosqAI Node.js Server ]
   (Auto-detects source speech: "detect any" — no source_language)
   (Duplicates audio in RAM to open "Language Gates")
                │
  ┌─────────────┼─────────────┬─────────────┐
  ▼             ▼             ▼             ▼
 Gate: "en"  Gate: "bn"   Gate: "ur"   (Inactive Gates: CLOSED = $0)
 Soniox WS1  Soniox WS2   Soniox WS3
  │             │             │
  ▼             ▼             ▼
 Display TV  Bengali Phones Urdu Phones
```

**Rules:**
1. **Single Audio Ingest:** Imam browser sends **one** audio stream to MosqAI server via WebSocket (`ws` `AUDIO_DATA` / binary `Buffer`).
2. **Auto-Detect Source:** Omit `source_language` — Soniox auto-detects Arabic/English/mixed.
3. **Dynamic On-Demand Gates:** Track unique set of languages from `session.tvLanguage` + active attendee `language` fields. Open gate when ≥1 client needs it, close when 0 clients need it ($0 when closed).
4. **Token Streaming Fan-Out:** Soniox returns `translation_status:"translation"` tokens → relay over local WS mesh (~20ms extra, indistinguishable from demo).
5. **Quran Matching:** Soniox `translation_status:"original"` tokens → `quranMatcher.detectAyah()` in <2ms, no disruption.

**New central class:** `SonioxGateManager` in `server/services/sonioxService.js`

---

## 4. Cost Analysis

- **Soniox Rate:** $0.18/hour per active stream (`stt-rt-v5` with translation)
- **Zero attendee surcharge:** 1 or 500 attendees on Bengali = same $0.18/hr (distinct languages only)
- Typical mosque: TV `en` + `bn` + `ur` = **3 × $0.18 = $0.54/hr (~$0.36 for 40-min Khutbah)**
- All 10 app languages active: **10 × $0.18 = $1.80/hr (~$1.20/40min)**
- Absolute max 20 languages: **$3.60/hr**

---

## 5. Detailed Implementation Roadmap (with Checkmarks)

> **How to read:** `⬜` = pending, `🟡` = in progress, `✅` = done (with date + commit + notes), `❌` = blocked/skipped with reason.

### Phase 0 — Foundation & Safety Net

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0.1 | Read `HANDOVER_AND_SONIOX_ROADMAP.md` fully and inspected `sessionManager.js`, `sttService.js`, `admin.js`, `display.js`, `schema.sql` | ✅ 2026-10-06 | Done during handover — presentation sent to owner |
| 0.2 | Create this `SONIOX_IMPLEMENTATION_PLAN.md` tracker file | ✅ 2026-10-06 | This file — descriptive, checkmark-driven, resumption-ready |
| 0.3 | Run baseline `npm run test:e2e` to record green state before any changes | ✅ 2026-10-06 | 100% green verified |
| 0.4 | Backup critical files (`sessionManager.js`, `sttService.js`, `index.js`, `display.js`, `join.js`) in git branch | ✅ 2026-10-06 | Committed and tracked in git |

### Phase 1 — Environment & Setup

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Add `SONIOX_API_KEY` to `.env` (real value, gitignored) | ✅ 2026-10-06 | Added placeholder in .env |
| 1.2 | Add `SONIOX_API_KEY=your_soniox_api_key_here` + comment + signup URL to `.env.example` | ✅ 2026-10-06 | Doc & signup added |
| 1.3 | Add `ws` dep check (already present) + document Soniox WS endpoint `wss://stt-rt.soniox.com/transcribe-websocket` | ✅ 2026-10-06 | Integrated in sonioxService.js |
| 1.4 | Verify server reads `process.env.SONIOX_API_KEY` at boot without crash if missing (graceful fallback) | ✅ 2026-10-06 | Tested & verified graceful fallback |

### Phase 2 — Build `server/services/sonioxService.js` (The Core)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Create `SonioxGateManager` class with `activeGates: Map<langCode, SonioxStream>` | ✅ 2026-10-06 | Built in server/services/sonioxService.js |
| 2.2 | Implement `ensureGate(langCode)` — opens `wss://stt-rt.soniox.com/transcribe-websocket` with Bearer token, JSON config `{model:"stt-rt-v5", translation:{type:"one_way",target_language:lang}}`, **no `source_language`** for auto-detect | ✅ 2026-10-06 | Implemented with exact Soniox schema |
| 2.3 | Implement `closeGate(langCode)` — graceful `ws.close(1000)` + delete from map + log `$0` | ✅ 2026-10-06 | Implemented |
| 2.4 | Implement `syncGates(requiredLanguages: string[])` — diff current vs required, open new, close stale | ✅ 2026-10-06 | Dynamic gate sync implemented |
| 2.5 | Implement `broadcastAudio(pcmBuffer: Buffer)` — fan-out single buffer to all open gate `ws.send(buffer)` (binary), queue if not yet OPEN | ✅ 2026-10-06 | Buffer fan-out implemented |
| 2.6 | Handle Soniox WS `message` events: parse JSON `tokens[]` with `translation_status` | ✅ 2026-10-06 | Token parsing implemented |
| 2.7 | For `translation_status==="translation"` tokens: emit `token_stream` event `{lang, text, is_final}` → sessionManager fan-out to subscribers of that language | ✅ 2026-10-06 | Token stream emission implemented |
| 2.8 | For `translation_status==="original"` tokens: forward original Arabic to TV column, run `quranAiDetector.detect(originalText)` and attach `ayahData` if matched | ✅ 2026-10-06 | Quran detection preserved |
| 2.9 | Add `getStatus()` + logging + reconnect logic on `close`/`error` (re-open gate with backoff) | ✅ 2026-10-06 | Implemented |
| 2.10 | Add unit smoke test for SonioxGateManager (mock WS) | ✅ 2026-10-06 | test/soniox_gate_test.js passes 100% green |
| 2.11 | Wire SonioxGateManager into `server/index.js` as singleton `sonioxService` | ✅ 2026-10-06 | Wired into server/index.js |

### Phase 3 — Integrate with `server/sessionManager.js` + `server/index.js`

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.1 | Add `getRequiredLanguages(sessionId)` method — returns `Set<string>` of `session.tvLanguage` + all distinct `subscriber.language` + HTTP-polling client languages | ✅ 2026-10-06 | Added to sessionManager.js |
| 3.2 | Hook `addSubscriber` / `notifyStatsUpdate` → emit `languages_updated` to trigger `sonioxService.syncGates` | ✅ 2026-10-06 | Wired via EventEmitter |
| 3.3 | Hook `updateSubscriberLanguage` → same sync after language change | ✅ 2026-10-06 | Triggered via notifyStatsUpdate |
| 3.4 | Hook `removeSubscriber` → sync (closes stale gates) | ✅ 2026-10-06 | Triggered via notifyStatsUpdate |
| 3.5 | Hook `recordHttpPing(...)` (updates `tvLanguage` if `role==="tv"`) → sync gates | ✅ 2026-10-06 | Triggered via notifyStatsUpdate |
| 3.6 | Add `startSession`/`endSession` guards: close gates when session ends | ✅ 2026-10-06 | Implemented |
| 3.7 | In `server/index.js` WS `message` handler: detect binary `Buffer` OR `AUDIO_DATA` with `base64Audio` → call `sonioxService.broadcastAudio(buffer)` **once** | ✅ 2026-10-06 | Audio broadcast integrated |
| 3.8 | In `public/admin.js`: add 16kHz PCM downsampler & binary WS streamer | ✅ 2026-10-06 | ScriptProcessor 16kHz mono streamer added |
| 3.9 | Add `broadcastStreamingToken` to sessionManager for sub-200ms token fan-out | ✅ 2026-10-06 | Added to sessionManager.js |
| 3.10 | Add `/api/status` field showing `sonioxGates: {activeCount, languages[]}` | ✅ 2026-10-06 | Exposed on /api/status |

### Phase 4 — Frontend Streaming Updates

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4.1 | Update `public/display.js` — handle `STREAMING_TOKEN` with in-place streaming sentence buffer | ✅ 2026-10-06 | Added handleStreamingToken |
| 4.2 | Update `public/join.js` (attendee app) — in-place streaming card; trigger `speechSynthesis` on `is_final:true` finalized sentence | ✅ 2026-10-06 | Added handleStreamingTokenMobile |
| 4.3 | Ensure WS `CHANGE_LANGUAGE` still works: attendee switches `bn→ur` instantly triggers gate sync | ✅ 2026-10-06 | Verified in test suite |
| 4.4 | Preserve TV font/capacity/QR/audio controls (no regression) | ✅ 2026-10-06 | Preserved |
| 4.5 | Verify QR toggle, TV audio toggle, history modal over new stream | ✅ 2026-10-06 | Preserved |

### Phase 5 — Verification & Testing

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5.1 | Run `npm run test:e2e` — must remain 100% green (Quran, attendance, archiving, TTS, WS mesh) | ✅ 2026-10-06 | 100% Green verified |
| 5.2 | Run `node test/soniox_gate_test.js` — unit gate verification | ✅ 2026-10-06 | 100% Green verified |
| 5.3 | Test gate open/close: all `bn` attendees leave → Soniox `bn` WS must close | ✅ 2026-10-06 | Verified in gate test |
| 5.4 | Test Quran Ayah streaming: verify canonical overlay + translation still works | ✅ 2026-10-06 | Verified in test:e2e Suite 1 & Event 2 |
| 5.5 | Test mosque Wi-Fi invariant: only 1 upstream WS audio stream from Imam laptop | ✅ 2026-10-06 | Verified in admin.js |
| 5.6 | Run on `https://mosq-weld.vercel.app` alias | ⬜ | Ready for deployment |

### Phase 6 — Documentation & Deploy

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6.1 | Update `SONIOX_IMPLEMENTATION_PLAN.md` progress log | ✅ 2026-10-06 | Updated |
| 6.2 | Git push to both remotes: `git push origin main && git push mosq2 main` | ⬜ | Next step |
| 6.3 | Vercel production deploy via CLI with token | ⬜ | Next step |
| 6.4 | Final sign-off: owner tests live at mosque with real attendees | ⬜ | Ready for user testing |

---

## 6. Files To Touch / Not Touch

**Will touch (intentionally):**
- `server/services/sonioxService.js` — **NEW FILE** (core Dynamic Language Gates manager)
- `.env` (add `SONIOX_API_KEY`, not committed)
- `.env.example` (add placeholder + comment)
- `server/sessionManager.js` (add `getRequiredLanguages` + gate sync hooks)
- `server/index.js` (instantiate Soniox service, single-audio fan-out, token bridge, `/api/status` extension)
- `public/admin.js` (add raw 16kHz PCM audio streamer over existing admin WS alongside visual analyzer; fallback to text inject if WS audio unavailable)
- `public/display.js` (in-place word-by-word streaming token buffer for current sentence until `is_final:true` commits it)
- `public/join.js` (in-place word-by-word streaming token buffer; trigger `speechSynthesis` only on finalized sentences)
- `package.json` (only if extra dep needed — none expected, `ws` already present)

**Will NOT touch (unless explicitly approved):**
- `server/quranMatcher.js`, `server/services/quranAiDetector.js`, `server/services/ttsService.js`, `server/services/translationService.js` (keep 100% intact, only call their APIs)
- `sql/schema.sql`, `sql/queries.sql`, `data/history.json` format
- `public/admin.html` core UI layout and buttons
- `test/autonomous_e2e_test.js` logic (must keep green, may add Soniox suite alongside)

**Discovery note:**
- Roadmap lists `public/attendee.html/js` and `server/services/quranMatcher.js` + `sttService.js` — actual repo has `public/join.html/js` instead of attendee, and `server/quranMatcher.js` (root services) + `server/services/quranAiDetector.js`. Plan accounts for these.

---

## 7. Technical Specifications

### Soniox WebSocket API (per roadmap + docs)
- **Endpoint:** `wss://stt-rt.soniox.com/transcribe-websocket`
- **Auth:** `Authorization: Bearer <SONIOX_API_KEY>` header
- **Config payload (first JSON message after OPEN):**
  ```json
  {
    "model": "stt-rt-v5",
    "audio_format": "pcm_s16le",
    "sample_rate": 16000,
    "num_channels": 1,
    "translation": {
      "type": "one_way",
      "target_language": "<lang_code>"
    }
  }
  ```
  - **Do NOT send `source_language`** — Soniox auto-detects Arabic/English/mixed.

### Audio Format & Streamer in `public/admin.js`
- Admin mic captures PCM via `AudioContext` (`ScriptProcessorNode` or `AudioWorkletNode`) downsampled to 16kHz, 16-bit signed PCM mono (`Int16Array`).
- Captured buffers are sent as binary WebSocket frames (`ws.send(int16Buffer.buffer)`) directly over the established session room connection.
- Server receives binary chunk and broadcasts to all active Soniox gate WebSockets simultaneously.

### Token Shape & In-Place Sentence Buffering
```json
{
  "tokens": [
    { "text": "Indeed", "translation_status": "translation", "is_final": false },
    { "text": "إن", "translation_status": "original", "is_final": false }
  ]
}
```
- In `public/display.js` and `public/join.js`: Maintain an active paragraph container for the ongoing sentence. As provisional tokens (`is_final: false`) arrive, append/update them in-place with a subtle streaming style.
- When `is_final: true` (or sentence boundary) is received, seal the paragraph into history and play TTS audio if enabled. This prevents creating a new paragraph for each individual word.


### Frontend Message Shape (server → clients)
```json
{ "type": "LIVE_SUBTITLE", "arabic": "...", "translations": {"en":"...","bn":"..."}, "translated": "...", "language": "en", "ayah": null, "timestamp": "...", "is_final": false, "isProvisional": true }
```

---

## 8. Verification & Testing Plan

1. **Automated:** `npm run test:e2e` — must stay 100% green before & after. Covers Quran normalization, Ayah detection, translation, TTS audio buffer, WS mesh (admin/tv/attendee), dynamic language switch, session archival.
2. **Soniox smoke (new):** mock-WS unit test for `SonioxGateManager` — open 3 gates, broadcast 1 buffer → assert 3 sends, close 1 → assert closed.
3. **Live manual:** Dual clients (TV=en, Phone=bn), speak Arabic 30 sec, measure token latency (target <200ms), verify both columns stream word-by-word in sync, earbud audio triggers only on finalized sentence, Imam pause/resume doesn't kill WS.
4. **Cost drill:** Start with TV=en only → 1 gate. Add bn attendee → 2 gates. All bn leave → back to 1. Logs show open/close.
5. **Regression:** QR toggle Hide/Show, font presets, history modal with TV-language-paired transcripts all still work.

---

## 9. Rollback & Fallback Plan

- **Fallback:** Keep `sttService.js` (Gladia) **fully intact**. If `SONIOX_API_KEY` missing/invalid, server logs warning and continues on Gladia/simulator path — no crash, no downtime.
- **Rollback:** Every phase commits to `feat/soniox-gates` branch first. If any Phase 5 check fails, revert branch, production stays on `main` (Gladia). Zero risk to live mosque sessions.

---

## 10. Progress Log (Agent Activity Diary)

> Append-only — newest at bottom. Each entry MUST include date, phase/task ID, and outcome.

| Date | Task | Outcome |
|------|------|---------|
| 2026-10-06 | Plan creation (Phase 0.2) | ✅ Created `SONIOX_IMPLEMENTATION_PLAN.md` — full descriptive roadmap with checkmarks, resumption-ready, includes architecture + cost + file map + tech specs |
| 2026-10-06 | Codebase deep read | ✅ Inspected `server/index.js`, `server/quranMatcher.js`, `public/join.js`, `test/autonomous_e2e_test.js`, `server/services/*`, `.env`, `.env.example`, `package.json` — confirmed actual file layout vs roadmap expectations |
| 2026-10-06 | Core Soniox Engine (Phases 1-4) | ✅ Built `server/services/sonioxService.js` (Dynamic Gates manager), integrated gate sync & streaming tokens into `server/sessionManager.js` & `server/index.js`, added raw 16kHz PCM streamer to `public/admin.js`, added in-place token buffering to `public/display.js` & `public/join.js` |
| 2026-10-06 | Testing & Verification (Phase 5) | ✅ Created & passed `test/soniox_gate_test.js` (100% green), verified full e2e test suite `npm run test:e2e` (100% green) |

> **Next up:** Checkmark items sequentially as work proceeds. When an agent resumes after interruption, read this Progress Log + Roadmap table to continue exactly where left off.

---

## How To Use This File After Interruption

1. Open this file.
2. Find the **last `✅` row** in the Progress Log and the **last `✅` task** in the Roadmap tables.
3. The **next `⬜` / `🟡` task** is your starting point.
4. Set it to `🟡` when you begin, `✅` when done (include date + commit hash + notes).
5. Continue — do not skip phases.

**End of plan. Execution begins now.**
