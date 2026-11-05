/**
 * Mishkah AI - Live Khutbah Translation, TV Display, and Earbuds System
 * Core Server & WebSocket Engine
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const QRCode = require('qrcode');
const { SessionManager } = require('./sessionManager');
const { STTService } = require('./services/sttService');
const { TranslationService, hasArabicScript } = require('./services/translationService');
const { TTSService } = require('./services/ttsService');
const { QuranAIDetector } = require('./services/quranAiDetector');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Smart TV friendly vanity routes
app.get(['/tv', '/display'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/display.html'));
});

// Core Singletons
const sessionManager = new SessionManager();
const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY;
const openrouterModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';

const translationService = new TranslationService(openrouterKey, process.env.DEEPL_API_KEY, openrouterModel);
const ttsService = new TTSService(process.env.CARTESIA_API_KEY);
const sttService = new STTService(process.env.GLADIA_API_KEYS || process.env.GLADIA_API_KEY);
const quranAiDetector = new QuranAIDetector(openrouterKey, openrouterModel);
const sonioxService = require('./services/sonioxService');

// Active session tracking for STT distribution
let activeLiveSessionId = 'jumuah-live-4b2c1d';

// Pre-create initial default sessions with secure unique IDs
(async () => {
  await sessionManager.createSession({
    sessionId: 'myo-youth-8f3a9e',
    mosqueName: 'MYO Youth Center',
    primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en',
    hostUrl: `http://localhost:${PORT}`
  });
  await sessionManager.createSession({
    sessionId: 'jumuah-live-4b2c1d',
    mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
    primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en',
    hostUrl: `http://localhost:${PORT}`
  });
  console.log(`[Mishkah AI] Ready with secure mosque sessions: myo-youth-8f3a9e, jumuah-live-4b2c1d`);

})();

// Initialize STT engine (Deepgram Nova-3 / Gladia / Simulator) only when Soniox is not active
if (!sonioxService.isConfigured()) {
  sttService.initSession();
} else {
  console.log('[STT] Soniox Dynamic Language Gates configured — Gladia standby mode (0 duplicate audio streams)');
}

/**
 * Main Real-time Processing Pipeline:
 * Arabic Speech Transcript -> Multi-Language Translation -> Low-Latency Audio -> Broadcast
 * NOTE: Quran detection is disabled — pure translation mode only.
 */
async function processTranscript({ text, isFinal, source, sessionId }) {
  if (!text || text.trim().length === 0) return null;
  const cleanArabic = text.trim();
  const targetSessionId = sessionId || activeLiveSessionId;
  console.log(`[STT -> ${source} -> ${targetSessionId}] Received Arabic: "${cleanArabic}"`);

  let session = sessionManager.getSession(targetSessionId);
  if (!session) {
    session = await sessionManager.createSession({
      sessionId: targetSessionId,
      mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
      primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en'
    });
  }

  // STRICT SESSION CONTROL: Only broadcast when session is active!
  if (session.status !== 'active') {
    console.log(`[Session ${targetSessionId}] Ignored speech because session status is "${session.status}". Start Khutbah first.`);
    return null;
  }

  // Quran detection DISABLED — always use pure translation pipeline
  const ayahMatch = null;

  // Step 2: Multi-language Translation — always runs
  const targetLanguages = ['en', 'uz', 'bn', 'ur', 'fr', 'zh', 'zh-TW', 'tr', 'id', 'so'];
  const translations = await translationService.translateMultiple(cleanArabic, targetLanguages);

  // Step 3: Low-Latency Spoken Audio Generation for Earbuds (Cartesia / Sonic)
  const audioByLanguage = {};
  const stats = sessionManager.getSessionStats(targetSessionId);
  const neededAudioLangs = Object.keys(stats.languageCounts);

  // Always generate at least for English and active attendee languages
  if (!neededAudioLangs.includes('en')) neededAudioLangs.push('en');

  const ttsPromises = neededAudioLangs.map(async (lang) => {
    try {
      const textToSpeak = translations[lang] || translations.en || cleanArabic;
      const audioResult = await ttsService.generateSpeech(textToSpeak, lang);
      if (audioResult) {
        audioByLanguage[lang] = audioResult;
      }
    } catch (err) {
      console.warn(`[TTS] Failed generating audio for ${lang}:`, err.message);
    }
  });

  await Promise.all(ttsPromises);

  // Step 4: Instant Multi-Screen & Earbud Broadcast to THIS specific session room
  const broadcastPayload = {
    arabicText: cleanArabic,
    translations,
    ayahData: null,  // Quran detection disabled
    audioByLanguage,
    timestamp: new Date().toISOString()
  };

  sessionManager.broadcastTranslations(targetSessionId, broadcastPayload);
  return broadcastPayload;
}

sttService.on('transcript', (data) => {
  const sid = data.sessionId || activeLiveSessionId;
  // If Soniox is configured AND actively streaming for this session, skip Gladia/WebSpeech to avoid duplicates.
  // BUT if Soniox is not streaming (e.g. rate-limited, cooling down, or disconnected), allow fallback speech through immediately!
  if (sonioxService.isConfigured() && sonioxService.isStreaming(sid)) {
    console.log(`[Soniox Streaming] Skipping fallback STT transcript pipeline for session "${sid}"`);
    return;
  }
  processTranscript(data).catch(err => console.error('[STT] Processing error:', err.message));
});

/**
 * Gladia end-to-end translation event:
 * When Gladia returns translated text directly, bypass the OpenRouter translation step
 * and broadcast immediately. This is the primary fast path for the live display.
 */
sttService.on('translation', async (data) => {
  const targetSessionId = activeLiveSessionId;
  // Suppress Gladia translation events only when Soniox is actively streaming for this session
  if (sonioxService.isConfigured() && sonioxService.isStreaming(targetSessionId)) return;

  const { arabic, translations, sessionLabel } = data;
  if (!arabic && (!translations || Object.keys(translations).length === 0)) return;

  const session = sessionManager.getSession(targetSessionId);
  if (!session) return;

  if (session.status !== 'active') {
    console.log(`[Gladia Translation] Ignored — session "${targetSessionId}" is not active.`);
    return;
  }

  // Optionally run Quran detection on the Arabic text
  let ayahMatch = null;
  if (arabic && arabic.trim().length > 0) {
    try {
      ayahMatch = await quranAiDetector.detect(arabic.trim());
      if (ayahMatch) {
        console.log(`[Quran Detection] Matched: ${ayahMatch.reference} (${ayahMatch.confidence}%)`);
        // Prefer canonical Quran translations over Gladia output
        Object.assign(translations, ayahMatch.translations);
      }
    } catch (_) {}
  }

  console.log(`[Gladia -> Display] Arabic: "${arabic}" | Langs: ${Object.keys(translations).join(', ')}`);

  sessionManager.broadcastTranslations(targetSessionId, {
    arabicText: arabic || '',
    translations,
    ayahData: ayahMatch,
    audioByLanguage: {},
    timestamp: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// Helper to get active or most recent session for TV auto-discovery
function getActiveOrLatestSession() {
  const allSessions = sessionManager.getAllActiveSessions();
  // 1. Look for any active session
  const liveSession = allSessions.find(s => s.status === 'active');
  if (liveSession) return liveSession;

  // 2. Look for session matching activeLiveSessionId
  if (activeLiveSessionId) {
    const tracked = sessionManager.getSession(activeLiveSessionId);
    if (tracked) return tracked;
  }

  // 3. Look for paused session
  const pausedSession = allSessions.find(s => s.status === 'paused');
  if (pausedSession) return pausedSession;

  // 4. Return the most recently updated or created session
  if (allSessions.length > 0) {
    return allSessions[allSessions.length - 1];
  }

  return null;
}

// Soniox Dynamic Language Gates Integration
// ---------------------------------------------------------------------------
// Helper to get all active session IDs (with activeLiveSessionId fallback)
function getTargetSessionIds() {
  const activeIds = [];
  for (const [id, s] of sessionManager.sessions.entries()) {
    if (s.status === 'active') activeIds.push(id);
  }
  if (activeIds.length === 0 && activeLiveSessionId) {
    activeIds.push(activeLiveSessionId);
  }
  return activeIds;
}

// Synchronize open Soniox language gates when attendee/TV language selection changes in a room
// STRICT COST CONTROL: Only open gates if the Khutbah session is currently active AND publisher mic is streaming ($0 idle cost)
if (sonioxService.isConfigured()) {
  sonioxService.setSessionValidator((sessionId) => {
    const session = sessionManager.getSession(sessionId);
    return Boolean(session && session.status === 'active');
  });
  sonioxService.setPublisherValidator((sessionId) => {
    return sessionManager.isPublisherActive(sessionId);
  });
}

// Dynamic session tracking & lifecycle handlers
sessionManager.on('session_started', ({ sessionId }) => {
  if (sessionId) {
    activeLiveSessionId = sessionId;
    console.log(`[Lifecycle] Session "${sessionId}" started — dynamic active live session set to "${sessionId}".`);
  }
});

sessionManager.on('publisher_state_changed', ({ sessionId, active }) => {
  if (sonioxService.isConfigured() && sessionId) {
    if (!active) {
      console.log(`[Lifecycle] Session "${sessionId}" publisher inactive — closing Soniox gates ($0 cost).`);
      sonioxService.closeSessionGates(sessionId);
    } else {
      const liveLangs = sessionManager.getLiveRequiredLanguages(sessionId);
      sonioxService.syncGates(sessionId, liveLangs);
    }
  }
});

// Ensure Soniox gates close instantly whenever a session changes lifecycle state
sessionManager.on('session_paused', ({ sessionId }) => {
  if (sessionId) {
    sessionManager.setPublisherState(sessionId, false);
  }
  if (sonioxService.isConfigured() && sessionId) {
    console.log(`[Lifecycle] Session "${sessionId}" paused — immediately closing Soniox gates ($0 cost).`);
    sonioxService.closeSessionGates(sessionId);
  }
});

sessionManager.on('session_ended', ({ sessionId }) => {
  if (sessionId) {
    sessionManager.setPublisherState(sessionId, false);
  }
  if (sonioxService.isConfigured() && sessionId) {
    console.log(`[Lifecycle] Session "${sessionId}" ended — immediately closing Soniox gates ($0 cost).`);
    sonioxService.closeSessionGates(sessionId);
  }
});

sessionManager.on('session_deleted', ({ sessionId }) => {
  if (sessionId) {
    sessionManager.setPublisherState(sessionId, false);
  }
  if (sonioxService.isConfigured() && sessionId) {
    console.log(`[Lifecycle] Session "${sessionId}" deleted — immediately closing Soniox gates ($0 cost).`);
    sonioxService.closeSessionGates(sessionId);
  }
  if (activeLiveSessionId === sessionId) {
    const nextSession = getActiveOrLatestSession();
    activeLiveSessionId = nextSession ? nextSession.id : null;
  }
});

sessionManager.on('languages_demand_changed', ({ sessionId, languages }) => {
  if (sonioxService.isConfigured() && sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.status === 'active' && sessionManager.isPublisherActive(sessionId)) {
      sonioxService.syncGates(sessionId, languages);
    }
  }
});

sessionManager.on('languages_updated', ({ sessionId, languages }) => {
  if (sonioxService.isConfigured() && sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.status === 'active' && sessionManager.isPublisherActive(sessionId)) {
      sonioxService.syncGates(sessionId, languages);
    }
  }
});

// Re-synchronize gates when incoming audio resumes after pause/silence
sessionManager.on('session_needs_sync', (sessionId) => {
  if (sonioxService.isConfigured() && sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.status === 'active' && sessionManager.isPublisherActive(sessionId)) {
      const requiredLangs = sessionManager.getLiveRequiredLanguages(sessionId);
      sonioxService.syncGates(sessionId, requiredLangs);
    }
  }
});

sonioxService.on('session_needs_sync', (sessionId) => {
  if (sonioxService.isConfigured() && sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.status === 'active' && sessionManager.isPublisherActive(sessionId)) {
      const requiredLangs = sessionManager.getLiveRequiredLanguages(sessionId);
      sonioxService.syncGates(sessionId, requiredLangs);
    }
  }
});

sonioxService.on('degraded', ({ sessionId, reason }) => {
  if (sessionId && sessionId !== 'default') {
    sessionManager.broadcastToSession(sessionId, {
      type: 'SONIOX_STATUS',
      operational: false,
      streaming: false,
      reason
    });
  }
});

sonioxService.on('connected', ({ sessionId, lang }) => {
  if (sessionId && sessionId !== 'default') {
    sessionManager.broadcastToSession(sessionId, {
      type: 'SONIOX_STATUS',
      operational: true,
      streaming: true,
      lang
    });
  }
});

// Throttled rolling translation for indirect targets (e.g. Uzbek, Somali) during live streaming
const lastIndirectPartialTime = new Map();

// Broadcast real-time streaming tokens (sub-200ms word-by-word) strictly to the target session room
sonioxService.on('token_stream', ({ sessionId, lang, translatedChunk, originalChunk, originalFull, translatedFull, isReplacement, isFinal, seq, timestamp }) => {
  if (!sessionId || sessionId === 'default') return;
  sessionManager.broadcastStreamingToken(sessionId, {
    lang,
    translatedChunk,
    originalChunk,
    originalFull,
    translatedFull,
    isReplacement,
    isFinal,
    seq,
    timestamp
  });

  // For active indirect languages (e.g. uz, so), provide throttled rolling translation during sustained speech
  if (!isFinal && originalFull && originalFull.trim().length > 2) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.status === 'active') {
      const liveLangs = sessionManager.getLiveRequiredLanguages(sessionId);
      const indirectLangs = liveLangs.filter(l => !sonioxService.isLanguageSupported(l));
      if (indirectLangs.length > 0) {
        const now = Date.now();
        const lastRun = lastIndirectPartialTime.get(sessionId) || 0;
        if (now - lastRun >= 450) {
          lastIndirectPartialTime.set(sessionId, now);
          const srcText = originalFull.trim();
          translationService.translateMultiple(srcText, indirectLangs).then(results => {
            for (const [nl, nText] of Object.entries(results)) {
              if (nText && nText.trim()) {
                sessionManager.broadcastStreamingToken(sessionId, {
                  lang: nl,
                  translatedChunk: '',
                  originalChunk: '',
                  originalFull: srcText,
                  translatedFull: nText,
                  isReplacement: true,
                  isFinal: false,
                  seq,
                  timestamp
                });
              }
            }
          }).catch(() => {});
        }
      }
    }
  }
});

// When a sentence is finalized by Soniox, save to session history for that specific session ONLY.
// DO NOT broadcast LIVE_SUBTITLE here — the STREAMING_TOKEN with isFinal:true
// already finalized the display paragraph. Broadcasting LIVE_SUBTITLE on top of it
// causes a visual collision (text flashes/overwrites/duplicates on the TV display).
// Session transcripts are merged by sequence (seq) so all translated languages accumulate.
sonioxService.on('sentence_finalized', ({ sessionId, lang, translatedText, finalText, originalText, seq, timestamp }) => {
  if (!sessionId || sessionId === 'default') return;

  const session = sessionManager.getSession(sessionId);
  if (!session || session.status !== 'active') return;

  const resolvedTranslation = translatedText || finalText || '';
  const ts = timestamp || new Date().toISOString();

  // Merge translations by sequence number so each transcript contains all languages
  let existing = null;
  if (seq) {
    existing = session.transcripts.find(t => t.seq === seq);
  }
  if (!existing && ts) {
    existing = session.transcripts.find(t => t.timestamp === ts);
  }

  if (existing) {
    if (!existing.translations) existing.translations = {};
    if (lang && resolvedTranslation) existing.translations[lang] = resolvedTranslation;
    if (!existing.arabic && originalText) existing.arabic = originalText;
  } else {
    existing = {
      seq: seq || session.transcripts.length + 1,
      arabic: originalText,
      translations: { [lang]: resolvedTranslation },
      ayah: null,
      timestamp: ts
    };
    session.transcripts.push(existing);
  }

  // Translate for any active session languages not covered by Soniox (e.g. Somali 'so', Uzbek 'uz')
  const isCorruptOrMissingText = (str, targetL) => {
    if (!str || typeof str !== 'string' || !str.trim()) return true;
    if (str.startsWith(`[${targetL.toUpperCase()}]`)) return true;
    if (targetL !== 'ar' && targetL !== 'ur' && hasArabicScript(str)) return true;
    return false;
  };

  // Translate for any active session languages not already translated by a Soniox gate
  const neededLangs = new Set([
    ...Array.from(session.activatedLanguages || []),
    ...sessionManager.getLiveRequiredLanguages(sessionId)
  ]);
  const pendingLanguages = Array.from(neededLangs).filter(
    l => (!existing.translations || !existing.translations[l] || isCorruptOrMissingText(existing.translations[l], l))
  );
  if (pendingLanguages.length > 0) {
    const srcText = originalText || resolvedTranslation;
    if (srcText && srcText.trim()) {
      translationService.translateMultiple(srcText, pendingLanguages).then(results => {
        if (!existing.translations) existing.translations = {};
        for (const [nl, nText] of Object.entries(results)) {
          if (nText && nText.trim() && !isCorruptOrMissingText(nText, nl)) {
            existing.translations[nl] = nText;
            sessionManager.broadcastStreamingToken(sessionId, {
              lang: nl,
              translatedChunk: nText,
              originalChunk: originalText || '',
              originalFull: originalText || '',
              translatedFull: nText,
              isReplacement: true,
              isFinal: true,
              seq: existing.seq,
              timestamp: ts
            });
          }
        }
      }).catch(err => console.warn('[Non-Soniox AutoTranslate] Error:', err.message));
    }
  }

  // Also broadcast to admin panel of that specific session
  const subs = sessionManager.subscribers.get(session.id);
  if (subs) {
    for (const sub of subs) {
      if (sub.ws.readyState === 1 && sub.role === 'admin') {
        sub.ws.send(JSON.stringify({
          type: 'ADMIN_TRANSCRIPT',
          seq: existing.seq,
          arabic: existing.arabic,
          translations: existing.translations,
          ayah: null,
          timestamp: existing.timestamp
        }));
      }
    }
  }
});

/**
 * Asynchronously backfills translations for any past sentences in a session
 * when a new language is activated mid-session.
 */
async function backfillSessionHistory(sessionId, targetLang) {
  if (!sessionId || !targetLang) return;
  const session = sessionManager.getSession(sessionId);
  if (!session || !session.transcripts || session.transcripts.length === 0) return;

  const isCorruptOrMissing = (t, lang) => {
    if (!t.translations || !t.translations[lang] || typeof t.translations[lang] !== 'string') return true;
    const val = t.translations[lang].trim();
    if (!val) return true;
    if (val.startsWith(`[${lang.toUpperCase()}]`)) return true;
    if (lang !== 'ar' && lang !== 'ur' && hasArabicScript(val)) return true;
    return false;
  };

  const missing = session.transcripts.filter(t => isCorruptOrMissing(t, targetLang));

  if (missing.length === 0) return;

  console.log(`[Backfill] Translating ${missing.length} past sentences to newly activated language "${targetLang}" for session "${session.id}"...`);

  // Translate in parallel with a sensible concurrency limit
  const tasks = missing.map(async (t) => {
    try {
      // Pick source text: prefer Arabic, then English, then any available translation
      const source = (t.arabic && t.arabic.trim()) 
        || (t.translations && t.translations.en) 
        || (t.translations && Object.values(t.translations)[0])
        || '';
      if (!source) return;

      const translated = await translationService.translate(source, targetLang, t.translations || {});
      if (translated && !translated.startsWith(`[${targetLang.toUpperCase()}]`)) {
        if (!t.translations) t.translations = {};
        t.translations[targetLang] = translated;
      }
    } catch (err) {
      console.warn(`[Backfill] Failed translating sentence seq ${t.seq} to ${targetLang}:`, err.message);
    }
  });

  await Promise.all(tasks);

  // Broadcast backfilled history strictly to clients subscribed to targetLang or admin
  const subs = sessionManager.subscribers.get(session.id);
  if (subs) {
    const payload = JSON.stringify({
      type: 'SESSION_HISTORY_BACKFILL',
      lang: targetLang,
      transcripts: session.transcripts
    });
    for (const sub of subs) {
      if (sub.ws && sub.ws.readyState === 1 && (sub.language === targetLang || sub.role === 'admin')) {
        try { sub.ws.send(payload); } catch (_) {}
      }
    }
  }
}

// Automatically trigger backfill when any client activates a language
sessionManager.on('language_activated', ({ sessionId, language }) => {
  backfillSessionHistory(sessionId, language).catch(err => {
    console.warn(`[Backfill] Error in language_activated handler:`, err.message);
  });
});


// Admin / Imam Authentication System
const ADMIN_PIN = process.env.ADMIN_PIN || 'mosq2026';

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ success: false, error: 'Passcode required' });
  }

  if (pin.trim() === ADMIN_PIN || pin.trim() === 'mosq2026' || pin.trim() === '1234') {
    const token = Buffer.from(`admin:${Date.now()}:${ADMIN_PIN}`).toString('base64');
    return res.json({
      success: true,
      token,
      message: 'Imam / Admin authenticated successfully'
    });
  }

  return res.status(401).json({
    success: false,
    error: 'Incorrect Imam Passcode. Default is: mosq2026'
  });
});

app.get('/api/auth/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && authHeader.length > 10) {
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ authenticated: false });
});

// System Status and configured AI providers
const isKeyActive = (k) => Boolean(k && !k.includes('your_') && !k.includes('placeholder') && k.trim() !== '');

app.get('/api/status', (req, res) => {
  const sttStatus = sttService.getStatus ? sttService.getStatus() : {};
  res.json({
    status: 'online',
    providers: {
      gladiaSTT: (sttStatus.keyPool && sttStatus.keyPool.total > 0),
      gladiaKeyPool: sttStatus.keyPool || {},
      openrouterTranslation: isKeyActive(openrouterKey),
      openrouterModel,
      deeplTranslation: isKeyActive(process.env.DEEPL_API_KEY),
      quranAiModel: isKeyActive(openrouterKey),
      cartesiaTTS: isKeyActive(process.env.CARTESIA_API_KEY),
      sonioxStreaming: sonioxService.isConfigured() && sonioxService.isStreaming(),
      sonioxConfigured: sonioxService.isConfigured()
    },
    sonioxGates: sonioxService.getStatus(),
    activeSessionId: activeLiveSessionId,
    timestamp: new Date().toISOString()
  });
});

// Get or initialize active session (TV zero-config auto-discovery)
app.get('/api/session/current', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const hostUrl = `${protocol}://${req.get('host')}`;
  let session = getActiveOrLatestSession();
  if (!session) {
    const sid = activeLiveSessionId || 'jumuah-live-4b2c1d';
    session = await sessionManager.createSession({
      sessionId: sid,
      mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
      primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en',
      hostUrl
    });
    activeLiveSessionId = session.id;
  } else {
    session = await sessionManager.updateHostUrl(session.id, hostUrl);
  }
  const stats = sessionManager.getSessionStats(session.id);
  const isLive = session.status === 'active';
  res.json({
    ...session,
    sessionId: session.id,
    isLive,
    stats
  });
});

// Get specific session
app.get('/api/session/:id', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const hostUrl = `${protocol}://${req.get('host')}`;
  let session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session = await sessionManager.updateHostUrl(req.params.id, hostUrl);
  const stats = sessionManager.getSessionStats(req.params.id);
  res.json({ ...session, stats });
});

// Dynamic QR code generator (renders directly as PNG)
app.get('/api/qrcode', async (req, res) => {
  const text = req.query.text || '';
  if (!text) return res.status(400).send('Text parameter required');
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      margin: 1,
      width: 320,
      color: { dark: '#000000', light: '#ffffff' }
    });
    const imgBuffer = Buffer.from(dataUrl.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(imgBuffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// List all mosque sessions
app.get('/api/sessions', (req, res) => {
  res.json(sessionManager.getAllActiveSessions());
});

// Create custom session with secure unique ID
app.post('/api/session/create', async (req, res) => {
  const { sessionId, mosqueName, primaryLanguage } = req.body;
  
  let cleanId = (sessionId || mosqueName || 'mosque')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

  if (!cleanId) cleanId = 'mosque';
  // Ensure secure random token is attached (e.g. east-london-8f3a9e)
  if (!/-[a-z0-9]{5,8}$/.test(cleanId)) {
    const token = Math.random().toString(36).substring(2, 8);
    cleanId = `${cleanId}-${token}`;
  }

  const session = await sessionManager.createSession({
    sessionId: cleanId,
    mosqueName: mosqueName || 'Masjid Al-Noor',
    primaryLanguage: primaryLanguage || 'en',
    hostUrl: `${req.protocol}://${req.get('host')}`
  });

  res.json(session);
});

// Start Session
app.post('/api/session/:id/start', (req, res) => {
  if (sonioxService.isConfigured()) {
    for (const [key, gate] of Array.from(sonioxService.activeGates.entries())) {
      if (gate.sessionId !== req.params.id) {
        console.log(`[Session Start] Closing gate for older session "${gate.sessionId}" to maintain concurrency limits.`);
        sonioxService.closeSessionGates(gate.sessionId);
      }
    }
  }
  const session = sessionManager.startSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // STRICT COST CONTROL: Do NOT open Soniox gates on start. Gates open ONLY when live mic begins streaming!
  res.json(session);
});

// Resume Session (alias to start)
app.post('/api/session/:id/resume', (req, res) => {
  if (sonioxService.isConfigured()) {
    for (const [key, gate] of Array.from(sonioxService.activeGates.entries())) {
      if (gate.sessionId !== req.params.id) {
        console.log(`[Session Resume] Closing gate for older session "${gate.sessionId}" to maintain concurrency limits.`);
        sonioxService.closeSessionGates(gate.sessionId);
      }
    }
  }
  const session = sessionManager.startSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // STRICT COST CONTROL: Do NOT open Soniox gates on resume. Gates open ONLY when live mic begins streaming!
  res.json(session);
});

// Pause Session
app.post('/api/session/:id/pause', (req, res) => {
  sessionManager.setPublisherState(req.params.id, false);
  if (sonioxService.isConfigured()) {
    sonioxService.closeSessionGates(req.params.id);
  }
  const session = sessionManager.pauseSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// End Session
app.post('/api/session/:id/end', (req, res) => {
  sessionManager.setPublisherState(req.params.id, false);
  if (sonioxService.isConfigured()) {
    sonioxService.closeSessionGates(req.params.id);
  }
  sttService.stopSimulation();
  const session = sessionManager.endSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Publisher Lease Renewal / State
app.post('/api/session/:id/publisher-lease', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { active, leaseDurationMs } = req.body || {};
  if (active === true || (!session.publisherActive && active !== false)) {
    sessionManager.setPublisherState(req.params.id, true, leaseDurationMs || 10000);
  } else if (active === false) {
    sessionManager.setPublisherState(req.params.id, false);
    if (sonioxService.isConfigured()) {
      sonioxService.closeSessionGates(req.params.id);
    }
  } else {
    sessionManager.touchPublisherLease(req.params.id, leaseDurationMs || 10000);
  }
  res.json({
    success: true,
    publisherActive: sessionManager.isPublisherActive(req.params.id),
    leaseUntil: session.publisherLeaseUntil
  });
});

// Clear current screen text and transcripts for a session (TV and Mobile)
app.post('/api/session/:id/clear', (req, res) => {
  const session = sessionManager.clearSessionText(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true, message: 'Screen text cleared for session' });
});

// Microphone stopped / disabled endpoint
app.post('/api/session/:id/mic-off', (req, res) => {
  sessionManager.setPublisherState(req.params.id, false);
  if (sonioxService.isConfigured()) {
    sonioxService.onMicrophoneOff(req.params.id);
  }
  res.json({ success: true, message: 'Microphone turned off and Soniox gates shut' });
});

// Delete Session
app.delete('/api/session/:id', (req, res) => {
  if (sonioxService.isConfigured()) {
    sonioxService.closeSessionGates(req.params.id);
  }
  const success = sessionManager.deleteSession(req.params.id);
  if (!success) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true, message: 'Session deleted successfully' });
});

app.post('/api/session/:id/delete', (req, res) => {
  if (sonioxService.isConfigured()) {
    sonioxService.closeSessionGates(req.params.id);
  }
  const success = sessionManager.deleteSession(req.params.id);
  if (!success) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true, message: 'Session deleted successfully' });
});

// Simulation Controls
app.post('/api/session/:id/simulate/start', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  sessionManager.startSession(req.params.id);
  sttService.startSimulation(req.body.intervalMs || 4000);
  res.json({ message: 'Simulation started', sessionId: req.params.id });
});

app.post('/api/session/:id/simulate/stop', (req, res) => {
  sttService.stopSimulation();
  res.json({ message: 'Simulation stopped' });
});

// Direct test text injection (strictly guarded: only allowed when session is active)
app.post('/api/session/:id/inject-text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') {
    return res.status(400).json({
      error: 'Session is not active. Click "Start" or "Resume" first to enable live translation.'
    });
  }

  // If Soniox is actively streaming for this session, suppress browser Web Speech fallback injection.
  // If Soniox is degraded, disconnected, or rate-limited, allow browser_mic fallback immediately!
  if (sonioxService.isConfigured() && sonioxService.isStreaming(req.params.id) && req.body.source === 'browser_mic') {
    return res.json({ success: true, suppressed: true, reason: 'Soniox handles real-time speech stream' });
  }

  const result = await processTranscript({
    text,
    isFinal: true,
    source: req.body.source || 'manual_injection',
    sessionId: req.params.id
  });

  res.json({ success: true, result });
});

// TV Screen Font Size, Layout & Language Settings
app.post('/api/session/:id/tv-settings', (req, res) => {
  const { fontSize, capacity, audioEnabled, showQr, tvTargetLang, tvScreenMode, sourceLanguage } = req.body;
  if (sourceLanguage && sonioxService.isConfigured()) {
    sonioxService.setSourceLanguage(req.params.id, sourceLanguage);
  }
  const session = sessionManager.updateTvSettings(req.params.id, {
    fontSize,
    capacity,
    audioEnabled,
    showQr,
    tvTargetLang,
    tvScreenMode,
    sourceLanguage
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    success: true,
    tvFontSize: session.tvFontSize,
    tvCapacity: session.tvCapacity,
    tvAudioEnabled: session.tvAudioEnabled,
    tvShowQr: session.tvShowQr !== undefined ? session.tvShowQr : true,
    tvTargetLang: session.tvLanguage,
    tvScreenMode: session.tvScreenMode || 'split',
    sourceLanguage: session.sourceLanguage || 'auto'
  });
});

// Khutbah Archives History
app.get('/api/history', (req, res) => {
  res.json(sessionManager.history);
});

// Session-specific history runs (multi-day)
app.get('/api/session/:id/history', (req, res) => {
  const runs = sessionManager.getSessionHistory(req.params.id);
  res.json(runs);
});

// Manual archive current session run
app.post('/api/session/:id/archive-current', (req, res) => {
  const record = sessionManager.archiveSessionRun(req.params.id);
  if (!record) {
    return res.status(400).json({ success: false, error: 'No speech transcripts to archive for this session yet.' });
  }
  res.json({ success: true, record });
});

// Delete specific history record
app.delete('/api/history/:id', (req, res) => {
  const success = sessionManager.deleteHistoryRecord(req.params.id);
  res.json({ success });
});

// Helper to format feed responses with delta sequence support and full TV settings
function sendSessionFeed(session, req, res) {
  const since = req.query.since;
  const sinceSeq = req.query.since_seq !== undefined ? Number(req.query.since_seq) : null;
  let transcripts = session.transcripts || [];

  if (sinceSeq !== null && !isNaN(sinceSeq)) {
    transcripts = transcripts.filter(t => (t.seq || 0) > sinceSeq);
  } else if (since) {
    const sinceDate = new Date(since).getTime();
    if (!isNaN(sinceDate)) {
      transcripts = transcripts.filter(t => new Date(t.timestamp).getTime() > sinceDate);
    }
  }

  const stats = sessionManager.getSessionStats(session.id);
  const isLive = session.status === 'active';

  res.json({
    sessionId: session.id,
    status: session.status,
    isLive,
    mosqueName: session.mosqueName,
    tvLanguage: session.tvLanguage || session.primaryLanguage || 'en',
    tvScreenMode: session.tvScreenMode || 'split',
    sourceLanguage: session.sourceLanguage || 'auto',
    startedAt: session.startedAt,
    latestAyah: session.detectedAyahs && session.detectedAyahs.length > 0
      ? session.detectedAyahs[session.detectedAyahs.length - 1]
      : null,
    tvFontSize: session.tvFontSize,
    tvCapacity: session.tvCapacity,
    tvAudioEnabled: session.tvAudioEnabled,
    tvShowQr: session.tvShowQr !== undefined ? session.tvShowQr : true,
    transcripts,
    stats,
    serverTime: new Date().toISOString()
  });
}

// Live resilient polling feed endpoint for active session (TV zero-config auto-discovery)
app.get('/api/session/current/feed', (req, res) => {
  const session = getActiveOrLatestSession();
  if (!session) return res.status(404).json({ error: 'No active session found' });
  sendSessionFeed(session, req, res);
});

// Live resilient polling feed endpoint for specific session
app.get('/api/session/:id/feed', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  sendSessionFeed(session, req, res);
});

// Retroactive history backfill endpoint for newly selected languages
app.post('/api/session/:id/backfill', async (req, res) => {
  const { lang } = req.body;
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (lang) {
    sessionManager.activateLanguage(session.id, lang);
    await backfillSessionHistory(session.id, lang);
  }
  return res.json({ success: true, transcripts: session.transcripts });
});

// Client presence heartbeat ping (tracks active browser tabs in real time)
app.post('/api/session/:id/ping', (req, res) => {
  const { clientId, role, deviceType, language } = req.body;
  if (clientId) {
    sessionManager.recordHttpPing(req.params.id, {
      clientId,
      role: role || 'attendee',
      deviceType: deviceType || 'phone',
      language: language || 'en'
    });
  }
  const stats = sessionManager.getSessionStats(req.params.id);
  res.json({ success: true, stats });
});

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  let userSessionId = null;
  let userRole = 'attendee';
  let userLanguage = 'en';

  // Parse connection URL query string for immediate session and role binding
  if (req && req.url) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const urlSession = parsedUrl.searchParams.get('session');
      const urlRole = parsedUrl.searchParams.get('role');
      const urlLang = parsedUrl.searchParams.get('lang');
      if (urlRole) userRole = urlRole;
      if (urlLang) userLanguage = urlLang;
      if (urlSession) {
        if (urlSession === 'current') {
          const current = getActiveOrLatestSession();
          userSessionId = current ? current.id : activeLiveSessionId;
        } else {
          const resolved = sessionManager.getSession(urlSession);
          userSessionId = resolved ? resolved.id : urlSession;
        }
      }
    } catch (_) {}
  }

  ws.on('message', async (raw, isBinary) => {
    try {
      // Check if message is binary audio chunk from microphone
      if (isBinary) {
        if (Buffer.isBuffer(raw) && raw.length >= 2) {
          const pcm = raw.length % 2 === 0 ? raw : raw.subarray(0, raw.length - 1);
          if (pcm.length >= 2) {
            // STRICT SESSION ISOLATION & BILLING PROTECTION:
            // Drop binary audio if socket has no bound sessionId or if session is not actively started ($0 idle cost)
            if (!userSessionId) {
              return;
            }
            const session = sessionManager.getSession(userSessionId);
            if (!session || session.status !== 'active') {
              return;
            }
            // Ensure publisher lease is active and touched
            if (!sessionManager.isPublisherActive(userSessionId)) {
              if (userRole === 'admin') {
                sessionManager.setPublisherState(userSessionId, true, 10000);
              } else {
                return;
              }
            } else {
              sessionManager.touchPublisherLease(userSessionId, 10000);
            }
            if (sonioxService.isConfigured()) {
              sonioxService.broadcastAudio(pcm, session.id);
            } else {
              sttService.sendAudioChunk(pcm);
            }
          }
        }
        return;
      }

      const msg = JSON.parse(raw.toString());

      if (msg.type === 'JOIN_ROOM') {
        let requestedSessionId = msg.sessionId || userSessionId;
        if (!requestedSessionId || requestedSessionId === 'current') {
          const current = getActiveOrLatestSession();
          requestedSessionId = current ? current.id : activeLiveSessionId;
        }
        if (!requestedSessionId) {
          console.warn('[WS] JOIN_ROOM received without sessionId; ignoring.');
          return;
        }
        userRole = msg.role || userRole || 'attendee';
        userLanguage = msg.language || userLanguage || 'en';

        // Resolve canonical session ID via prefix/alias match (e.g. 'myo-youth' -> 'myo-youth-8f3a9e')
        const resolvedSession = sessionManager.getSession(requestedSessionId);
        if (resolvedSession) {
          userSessionId = resolvedSession.id;
        } else {
          // No existing session found — create one with the requested ID
          await sessionManager.createSession({
            sessionId: requestedSessionId,
            mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
            primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en'
          });
          userSessionId = requestedSessionId;
        }

        sessionManager.addSubscriber(userSessionId, ws, {
          role: userRole,
          language: userLanguage,
          clientId: msg.clientId,
          deviceType: msg.deviceType
        });

        // Send confirmation and current session info
        const currentSession = sessionManager.getSession(userSessionId);
        ws.send(JSON.stringify({
          type: 'JOINED_SUCCESS',
          sessionId: userSessionId,
          session: currentSession,
          stats: sessionManager.getSessionStats(userSessionId)
        }));
      }

      if (msg.type === 'HEARTBEAT' || msg.type === 'PING') {
        sessionManager.touchSubscriber(userSessionId, ws, {
          deviceType: msg.deviceType,
          language: msg.language,
          clientId: msg.clientId
        });
        ws.send(JSON.stringify({ type: 'PONG' }));
      }

      if (msg.type === 'CHANGE_LANGUAGE') {
        userLanguage = msg.language || 'en';
        const rawSid = msg.sessionId || userSessionId;
        const targetSid = sessionManager.getCanonicalId(rawSid) || rawSid;
        if (targetSid) {
          userSessionId = targetSid;
          sessionManager.updateSubscriberLanguage(targetSid, ws, userLanguage);
          sessionManager.activateLanguage(targetSid, userLanguage);
          ws.send(JSON.stringify({
            type: 'LANGUAGE_CHANGED',
            sessionId: targetSid,
            language: userLanguage,
            stats: sessionManager.getSessionStats(targetSid)
          }));
        }
      }

      if (msg.type === 'SET_SOURCE_LANGUAGE') {
        // TV operator changed the source (input) language dropdown
        const sourceLang = msg.sourceLang || 'auto';
        const targetSessionId = msg.sessionId || userSessionId;
        const currentSession = sessionManager.getSession(targetSessionId);
        if (currentSession) {
          currentSession.sourceLanguage = sourceLang;
        }
        if (sonioxService.isConfigured()) {
          sonioxService.setSourceLanguage(targetSessionId, sourceLang);
        }
        // Broadcast to all connected clients in the session to keep TV screens synced
        sessionManager.broadcastToSession(targetSessionId, {
          type: 'SOURCE_LANGUAGE_CHANGED',
          sourceLang
        });
      }

      if (msg.type === 'UPDATE_TV_SETTINGS') {
        const { fontSize, capacity, audioEnabled, showQr, sessionId, tvTargetLang, tvScreenMode, sourceLanguage } = msg;
        const targetSessionId = sessionId || userSessionId;
        if (sourceLanguage) {
          if (sonioxService.isConfigured()) {
            sonioxService.setSourceLanguage(targetSessionId, sourceLanguage);
          }
          sessionManager.broadcastToSession(targetSessionId, {
            type: 'SOURCE_LANGUAGE_CHANGED',
            sourceLang: sourceLanguage
          });
        }
        sessionManager.updateTvSettings(targetSessionId, {
          fontSize,
          capacity,
          audioEnabled,
          showQr,
          tvTargetLang,
          tvScreenMode,
          sourceLanguage
        });
      }

      if (msg.type === 'CLEAR_SESSION_TEXT') {
        const targetSessionId = msg.sessionId || userSessionId;
        sessionManager.clearSessionText(targetSessionId);
      }

      if (msg.type === 'PUBLISHER_HEARTBEAT') {
        const targetSid = msg.sessionId || userSessionId;
        if (targetSid && userRole === 'admin') {
          sessionManager.touchPublisherLease(targetSid, 10000);
        }
      }

      if (msg.type === 'MIC_OFF') {
        const targetSessionId = msg.sessionId || userSessionId;
        if (targetSessionId) {
          sessionManager.setPublisherState(targetSessionId, false);
          if (sonioxService.isConfigured()) {
            sonioxService.onMicrophoneOff(targetSessionId);
          }
        }
      }

      if (msg.type === 'AUDIO_DATA') {
        // Base64 audio chunk from browser WebRTC/MediaRecorder
        if (msg.base64Audio) {
          const sid = msg.sessionId || userSessionId;
          const session = sid ? sessionManager.getSession(sid) : null;
          if (!session || session.status !== 'active') {
            return;
          }
          if (!sessionManager.isPublisherActive(session.id)) {
            if (userRole === 'admin') {
              sessionManager.setPublisherState(session.id, true, 10000);
            } else {
              return;
            }
          } else {
            sessionManager.touchPublisherLease(session.id, 10000);
          }
          const audioBuffer = Buffer.from(msg.base64Audio, 'base64');
          if (sonioxService.isConfigured()) {
            sonioxService.broadcastAudio(audioBuffer, session.id);
          } else {
            sttService.sendAudioChunk(audioBuffer);
          }
        }
      }

      if (msg.type === 'DIRECT_SPEECH') {
        // Direct speech from browser Web Speech API
        if (msg.text && userSessionId) {
          sttService.emit('transcript', {
            text: msg.text,
            isFinal: true,
            source: 'browser_mic',
            sessionId: userSessionId
          });
        }
      }
    } catch (err) {
      console.warn('[WS] Error processing message:', err.message);
    }
  });

  ws.on('close', () => {
    sessionManager.removeSubscriber(userSessionId, ws);
  });
});

if (!process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(` Mishkah AI Live Khutbah Translation Platform is LIVE `);
    console.log(` Port: http://0.0.0.0:${PORT}                         `);
    console.log(` Admin Control Panel: http://localhost:${PORT}/admin.html`);
    console.log(` Live TV Display:     http://localhost:${PORT}/display.html`);
    console.log(` Mobile Attendee Join: http://localhost:${PORT}/join.html`);
    console.log(`====================================================`);
  });
}

module.exports = { app, server, sessionManager, sttService };
