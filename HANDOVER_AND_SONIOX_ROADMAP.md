# MosqAI: Master Handover & Soniox Migration Roadmap

> **IMPORTANT NOTICE FOR INCOMING DEVELOPER / AI AGENT:**  
> **DO NOT** modify existing code or make breaking changes without reading this entire document first.  
> You must **present your execution plan to the Project Owner** and **obtain explicit approval** before proceeding with any code modifications. All existing production features (Quran Ayah detection, live attendance counter, multi-day session history, audio playback, TV display alignment, and QR toggle) must remain 100% operational.

---

## 1. Project Overview & Mission

**MosqAI** is a real-time live Khutbah translation and congregation engagement platform built for mosques and Islamic centers.

### The User Experience:
1. **Pulpit / Imam**: The Imam speaks naturally into a microphone (in Arabic, English, or mixed dialects).
2. **Display TV / Projector**: A large screen in the prayer hall displays the speech side-by-side: original Arabic on the right, live translation on the left.
3. **Mobile Attendees**: Attendees scan a QR code on the TV screen to open the attendee web app on their phones (**zero app install required**). Each attendee selects their preferred language (e.g., Bengali, Urdu, English, French, Somali, Turkish, Chinese Mandarin, Traditional Chinese).
4. **Earbud Listening**: Attendees can tap **Listen** to hear live audio translation in their earbuds using free native browser speech synthesis (`window.speechSynthesis`).
5. **Quranic Ayah Detection**: When the Imam recites from the Holy Quran, MosqAI's fuzzy matching engine identifies the verse across all 6,236 Ayahs, displaying the canonical Uthmani script and official translation.
6. **Multi-Day Session History**: Every sermon run is archived with date, time, duration, peak attendance (separated into phones vs TV screens), and transcripts paired with display TV translations.

---

## 2. Codebase Architecture & File Directory

The project is a lightweight, zero-bloat Node.js / Express application with Vanilla HTML/CSS/JavaScript frontends for maximum speed, zero build overhead, and instant mobile responsiveness.

```
mosq/
├── server/
│   ├── index.js                  # Express HTTP & WebSocket server, REST APIs, SSE endpoints
│   ├── sessionManager.js         # Core state engine: active sessions, device tracking, multi-day history, WS broadcast
│   └── services/
│       ├── sttService.js         # Current Speech-to-Text WebSocket pipeline (Gladia key pool)
│       ├── translationService.js # Multi-language translation engine with memory caching
│       ├── quranMatcher.js       # In-memory fuzzy Ayah detector across 6,236 Quranic verses
│       └── ttsService.js         # Audio buffer synthesizer fallback
├── public/
│   ├── admin.html / admin.js     # Pulpit Console & Master Admin Dashboard (attendance, history modal, QR toggle)
│   ├── display.html / display.js # TV screen display (side-by-side alignment, font sizes, QR code, audio)
│   └── attendee.html / attendee.js# Mobile attendee web app (language selection, earbud audio player)
├── sql/
│   ├── schema.sql                # Supabase / PostgreSQL schema (all tables prefixed with `mosq_` for zero collisions)
│   └── queries.sql               # Ready-to-use SQL queries for sermon insertion, history retrieval, and analytics
├── data/
│   ├── sessions.json             # Persistent local JSON storage for session configurations
│   └── history.json              # Persistent local JSON storage for multi-day sermon runs
├── test/
│   └── autonomous_e2e_test.js    # Comprehensive end-to-end automated test suite (100% green verification)
└── HANDOVER_AND_SONIOX_ROADMAP.md# THIS FILE
```

---

## 3. Working Production Features (DO NOT BREAK)

Before making any changes, verify and preserve the following features:

1. **Quran Ayah Detection Engine (`quranMatcher.js`)**:
   - Normalizes Arabic diacritics and runs fuzzy matching across 6,236 verses.
   - Emits canonical Arabic script + verified translations.
2. **Live Attendance Counter (`sessionManager.js`, `admin.js`)**:
   - Accurately separates connected browsers into **Mobile Phones (📱)** and **TV Screens / Computers (🖥️)** based on User-Agent and client roles (`attendee` vs `tv`).
3. **Multi-Day Session History Modal**:
   - Accessible via the session cards in Master Admin and the Pulpit Console header.
   - Archives each sermon run with date, start time, duration, attendance breakdown, and speech lines paired with the **Display TV's target translation**.
   - Backed by isolated Supabase SQL (`mosq_` tables) and auto-persisting `data/history.json`.
4. **Display TV Layout & Controls (`display.html`, `admin.js`)**:
   - Original Arabic and translation start at the exact same vertical level.
   - **Hide / Show QR Toggle**: Controlled live from the admin panel to hide or reveal the attendee QR code on the TV screen.
   - **Font Size & Line Capacity Controls**: Admin can toggle TV font size and line capacity (up to 12 lines / 3X buffer).
   - **Audio Playback**: Admin controls speech audio on the TV; attendees control individual audio on their mobile phones.
5. **Language Support**:
   - 10 active languages supported on TV and mobile: English (`en`), Uzbek (`uz`), Turkish (`tr`), Urdu (`ur`), Bengali (`bn`), French (`fr`), Chinese Mandarin (`zh`), Traditional Chinese (`zh-TW`), Indonesian (`id`), Somali (`so`).

---

## 4. The Next Big Task: Migration to Soniox

### Why Are We Migrating to Soniox?
Currently, Speech-to-Text and Translation run in two consecutive stages (transcribe sentence ➔ wait for completion ➔ translate). While functional, this creates a 2–3 second delay.

The Project Owner tested Soniox's live streaming demo at:
🔗 **`https://soniox.com/speech-translation/arabic/english`**

In that demo, translation tokens stream **mid-sentence word-by-word** while the speaker is still talking, achieving sub-200ms latency. The Project Owner was completely satisfied with this speed and wants this exact experience across both the Display TV and all attendee mobile phones.

---

### The "Dynamic Language Gates" Audio Fan-Out Architecture

#### Why We Cannot Send Audio Directly From Browser to Soniox:
1. **Mosque Wi-Fi Preservation**: 1 Soniox connection translates to 1 language only. If the Imam's laptop streamed 5 to 10 languages directly to Soniox, it would upload 5 to 10 duplicate audio streams simultaneously, overwhelming mosque Wi-Fi.
2. **Broadcast Responsibility**: Soniox does not broadcast to attendees; it only streams tokens back to the sender. A central server is required to distribute subtitles to the 100+ attendees in the room.

#### The Approved Architecture:
```
[ Imam Microphone (Admin Browser) ]
                │
                ▼ (1 single WebSocket stream over mosque Wi-Fi)
       [ MosqAI Node.js Server ]
   (Auto-detects source speech: "detect any")
   (Duplicates audio in RAM to open "Language Gates")
                │
  ┌─────────────┼─────────────┬─────────────┐
  ▼             ▼             ▼             ▼
Gate: "en"    Gate: "bn"    Gate: "ur"    (Inactive Gates: CLOSED = $0)
Soniox WS 1   Soniox WS 2   Soniox WS 3
  │             │             │
  ▼             ▼             ▼
Display TV    Bengali Phones Urdu Phones
```

#### Key Architectural Rules:
1. **Single Audio Ingest**: The Imam's browser sends **one audio stream** to the MosqAI server via WebSocket.
2. **Auto-Detect Source Language**:
   - Omit `source_language` in Soniox's configuration. Soniox will automatically detect Arabic, English, or any mixed dialect.
3. **Dynamic On-Demand Gates**:
   - MosqAI tracks the unique set of languages actively selected by the Display TV and connected attendees.
   - **Gate Open**: When at least 1 client is on a language (e.g., TV is `en`, 12 attendees are `bn`), MosqAI opens/maintains a Soniox WebSocket for that `target_language`.
   - **Gate Close**: When all attendees using a language leave or switch, MosqAI closes that Soniox connection so you **never pay for unused streams**.
4. **Token Streaming Fan-Out**:
   - Soniox returns streaming tokens with `translation_status: "translation"`.
   - MosqAI relays these tokens over its local WebSocket mesh to the matching clients. Total additional latency is ~20ms, making it physically indistinguishable from the demo page.
5. **Quran Ayah Matching**:
   - Soniox also returns original speech tokens (`translation_status: "original"`).
   - MosqAI feeds these original tokens into `server/services/quranMatcher.js` to detect Ayahs in real time (< 2ms) without disrupting the translation stream.

---

### Cost Analysis (Soniox Pricing)

- **Soniox Real-Time Translation Rate**: **$0.18 / hour per active stream** (`stt-rt-v5` with translation enabled).
- **Zero Attendee Surcharge**: Cost depends **only** on the number of distinct active languages, **not** on the number of attendees (1 attendee or 500 attendees on Bengali costs the exact same $0.18/hr).
- **Typical Mosque Session** (TV on English + 2 attendee languages like Urdu and Bengali):
  - **3 active streams × $0.18/hr = $0.54 per hour** (approx. **$0.36** for a 40-minute Khutbah).
- **Maximum Possible Cost (All 10 app languages active simultaneously)**:
  - **10 streams × $0.18/hr = $1.80 per hour** (approx. **$1.20** for a 40-minute Khutbah).
- **Absolute Maximum (20 languages simultaneously)**:
  - **20 streams × $0.18/hr = $3.60 per hour**.

---

## 5. Step-by-Step Implementation Roadmap for the Incoming Developer

Follow these exact steps when implementing the Soniox migration:

### Phase 1: Environment & Setup
1. Add `SONIOX_API_KEY` to `.env` and `.env.example`.
2. Review Soniox WebSocket API endpoint:
   - Endpoint: `wss://stt-rt.soniox.com/transcribe-websocket`
   - Authorization: Bearer token in headers or subprotocol.
   - Target configuration payload:
     ```json
     {
       "model": "stt-rt-v5",
       "translation": {
         "type": "one_way",
         "target_language": "<lang_code>"
       }
     }
     ```

### Phase 2: Build `server/services/sonioxService.js`
1. Create a `SonioxGateManager` class:
   - Manages a map of active language gates: `activeGates: Map<langCode, SonioxStream>`.
   - Method `ensureGate(langCode)`: Opens a WebSocket connection to Soniox for that language if not already open.
   - Method `closeGate(langCode)`: Gracefully terminates the connection when 0 clients are listening to that language.
   - Method `broadcastAudio(pcmBuffer)`: Sends audio chunks to all currently open gates.
2. Handle Soniox WebSocket responses:
   - Parse `tokens`:
     - Tokens with `translation_status === 'translation'`: Dispatch to session subscribers listening to that language.
     - Tokens with `translation_status === 'original'`: Pass to `quranMatcher.matchAyah()` and forward to original Arabic subtitles.

### Phase 3: Integrate with `server/sessionManager.js`
1. Hook into `addSubscriber`, `updateSubscriberLanguage`, and subscriber disconnect handlers.
2. Compute `getRequiredLanguages(sessionId)`:
   - Includes `session.tvLanguage` (always active while session is live).
   - Includes distinct languages from active attendee clients.
3. Call `sonioxService.syncGates(requiredLanguages)`.

### Phase 4: Frontend Streaming Updates
1. Ensure `display.js` and `attendee.js` handle incoming word-by-word streaming tokens smoothly (displaying provisional words with subtle styling until `is_final: true`).
2. Verify in-browser speech synthesis triggers cleanly on finalized sentences for earbud listeners.

### Phase 5: Verification & Testing
1. Run `npm run test:e2e` to verify zero regression across Quran detection, attendance tracking, and session archiving.
2. Perform live microphone test with dual clients (one English TV display, one Bengali attendee) and confirm simultaneous streaming.

---

## 6. How to Run, Test, and Deploy

- **Run Dev Server**:
  ```bash
  npm run dev
  ```
  Starts server on `http://localhost:3000` (or configured port).

- **Run Automated Test Suite**:
  ```bash
  npm run test:e2e
  ```
  Runs `test/autonomous_e2e_test.js` validating Quran matcher, translation, earbud audio generation, WebSocket mesh, and session archiving. Must be **100% green**.

- **Git Repositories**:
  - Remote `origin`: `https://github.com/pshahidhasan-rgb/mosq2.git` (branch: `main`)
  - Remote `mosq2`: `https://github.com/pshahidhasan-rgb/mosq2.git` (branch: `main`)
  - Keep both remotes synced on push: `git push origin main && git push mosq2 main`.

- **Vercel Production Deployment**:
  - Aliased Production URL: `https://mosq-weld.vercel.app`
  - Deployed using Vercel CLI with production token.

---

## 7. Mandatory Developer Protocol

Before writing any code or making edits to existing files:

1. **Read this file completely.**
2. **Inspect the existing files**:
   - [server/sessionManager.js](file:///Users/shahidhasan/createHalal/mosq/server/sessionManager.js)
   - [server/services/sttService.js](file:///Users/shahidhasan/createHalal/mosq/server/services/sttService.js)
   - [public/admin.js](file:///Users/shahidhasan/createHalal/mosq/public/admin.js)
   - [public/display.js](file:///Users/shahidhasan/createHalal/mosq/public/display.js)
   - [sql/schema.sql](file:///Users/shahidhasan/createHalal/mosq/sql/schema.sql)
3. **Formulate your implementation plan**: Outline exactly which files you plan to touch, how you will implement the Soniox "Dynamic Language Gates" manager, and how you will test it.
4. **ASK THE PROJECT OWNER FOR APPROVAL**: Present your plan to the Project Owner, explain what you will do step-by-step, and wait for their explicit permission before executing.
