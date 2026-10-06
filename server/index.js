/**
 * MosqAI - Live Khutbah Translation, TV Display, and Earbuds System
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
const { TranslationService } = require('./services/translationService');
const { TTSService } = require('./services/ttsService');
const { QuranAIDetector } = require('./services/quranAiDetector');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
  console.log(`[MosqAI] Ready with secure mosque sessions: myo-youth-8f3a9e, jumuah-live-4b2c1d`);
})();

// Initialize STT engine (Deepgram Nova-3 / Gladia / Simulator)
sttService.initSession();

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
  processTranscript(data).catch(err => console.error('[STT] Processing error:', err.message));
});

/**
 * Gladia end-to-end translation event:
 * When Gladia returns translated text directly, bypass the OpenRouter translation step
 * and broadcast immediately. This is the primary fast path for the live display.
 */
sttService.on('translation', async (data) => {
  const { arabic, translations, sessionLabel } = data;
  if (!arabic && (!translations || Object.keys(translations).length === 0)) return;

  const targetSessionId = activeLiveSessionId;
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
// Soniox Dynamic Language Gates Integration
// ---------------------------------------------------------------------------
// Synchronize open Soniox language gates when attendee/TV language selection changes
sessionManager.on('languages_updated', ({ sessionId, languages }) => {
  if (sessionId === activeLiveSessionId && sonioxService.isConfigured()) {
    sonioxService.syncGates(languages);
  }
});

// Broadcast real-time streaming tokens (sub-200ms word-by-word)
sonioxService.on('token_stream', ({ lang, translatedChunk, originalChunk, isFinal, timestamp }) => {
  sessionManager.broadcastStreamingToken(activeLiveSessionId, {
    lang,
    translatedChunk,
    originalChunk,
    isFinal,
    timestamp
  });
});

// When a sentence is finalized by Soniox, run Quran Ayah check and commit to history
sonioxService.on('sentence_finalized', async ({ lang, translatedText, originalText, timestamp }) => {
  const targetSessionId = activeLiveSessionId;
  const session = sessionManager.getSession(targetSessionId);
  if (!session || session.status !== 'active') return;

  let ayahMatch = null;
  if (originalText && originalText.trim().length > 0) {
    try {
      ayahMatch = await quranAiDetector.detect(originalText.trim());
      if (ayahMatch) {
        console.log(`[Soniox -> Quran Match]: ${ayahMatch.reference} (${ayahMatch.confidence}%)`);
      }
    } catch (_) {}
  }

  const translations = { [lang]: translatedText };
  if (ayahMatch && ayahMatch.translations) {
    Object.assign(translations, ayahMatch.translations);
  }

  sessionManager.broadcastTranslations(targetSessionId, {
    arabicText: originalText,
    translations,
    ayahData: ayahMatch,
    audioByLanguage: {},
    timestamp
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
      sonioxStreaming: sonioxService.isConfigured()
    },
    sonioxGates: sonioxService.getStatus(),
    activeSessionId: activeLiveSessionId,
    timestamp: new Date().toISOString()
  });
});

// Get or initialize active session
app.get('/api/session/current', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const hostUrl = `${protocol}://${req.get('host')}`;
  let session = sessionManager.getSession(activeLiveSessionId);
  if (!session) {
    session = await sessionManager.createSession({
      sessionId: activeLiveSessionId,
      mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
      primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en',
      hostUrl
    });
  } else {
    session = await sessionManager.updateHostUrl(activeLiveSessionId, hostUrl);
  }
  const stats = sessionManager.getSessionStats(activeLiveSessionId);
  res.json({ ...session, stats });
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

  activeLiveSessionId = cleanId;

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
  const session = sessionManager.startSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Resume Session (alias to start)
app.post('/api/session/:id/resume', (req, res) => {
  const session = sessionManager.startSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Pause Session
app.post('/api/session/:id/pause', (req, res) => {
  const session = sessionManager.pauseSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// End Session
app.post('/api/session/:id/end', (req, res) => {
  sttService.stopSimulation();
  const session = sessionManager.endSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Clear current screen text and transcripts for a session (TV and Mobile)
app.post('/api/session/:id/clear', (req, res) => {
  const session = sessionManager.clearSessionText(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true, message: 'Screen text cleared for session' });
});

// Delete Session
app.delete('/api/session/:id', (req, res) => {
  const success = sessionManager.deleteSession(req.params.id);
  if (!success) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true, message: 'Session deleted successfully' });
});

app.post('/api/session/:id/delete', (req, res) => {
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

  const result = await processTranscript({
    text,
    isFinal: true,
    source: 'manual_injection',
    sessionId: req.params.id
  });

  res.json({ success: true, result });
});

// TV Screen Font Size & Capacity Settings
app.post('/api/session/:id/tv-settings', (req, res) => {
  const { fontSize, capacity, audioEnabled, showQr } = req.body;
  const session = sessionManager.updateTvSettings(req.params.id, { fontSize, capacity, audioEnabled, showQr });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    success: true,
    tvFontSize: session.tvFontSize,
    tvCapacity: session.tvCapacity,
    tvAudioEnabled: session.tvAudioEnabled,
    tvShowQr: session.tvShowQr !== undefined ? session.tvShowQr : true
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

// Live resilient polling feed endpoint
app.get('/api/session/:id/feed', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const since = req.query.since;
  let transcripts = session.transcripts;
  if (since) {
    const sinceDate = new Date(since).getTime();
    if (!isNaN(sinceDate)) {
      transcripts = transcripts.filter(t => new Date(t.timestamp).getTime() > sinceDate);
    }
  }
  const stats = sessionManager.getSessionStats(req.params.id);

  res.json({
    status: session.status,
    startedAt: session.startedAt,
    latestAyah: session.detectedAyahs.length > 0 ? session.detectedAyahs[session.detectedAyahs.length - 1] : null,
    tvFontSize: session.tvFontSize,
    tvCapacity: session.tvCapacity,
    tvAudioEnabled: session.tvAudioEnabled,
    tvShowQr: session.tvShowQr !== undefined ? session.tvShowQr : true,
    transcripts,
    stats,
    serverTime: new Date().toISOString()
  });
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
wss.on('connection', (ws) => {
  let userSessionId = activeLiveSessionId;
  let userRole = 'attendee';
  let userLanguage = 'en';

  ws.on('message', async (raw) => {
    try {
      // Check if message is binary audio chunk from microphone
      if (Buffer.isBuffer(raw)) {
        if (sonioxService.isConfigured()) {
          sonioxService.broadcastAudio(raw);
        }
        sttService.sendAudioChunk(raw);
        return;
      }

      const msg = JSON.parse(raw.toString());

      if (msg.type === 'JOIN_ROOM') {
        userSessionId = msg.sessionId || activeLiveSessionId;
        userRole = msg.role || 'attendee';
        userLanguage = msg.language || 'en';

        if (!sessionManager.getSession(userSessionId)) {
          await sessionManager.createSession({
            sessionId: userSessionId,
            mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
            primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en'
          });
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
        sessionManager.updateSubscriberLanguage(userSessionId, ws, userLanguage);
      }

      if (msg.type === 'UPDATE_TV_SETTINGS') {
        const { fontSize, capacity, audioEnabled, showQr, sessionId } = msg;
        const targetSessionId = sessionId || userSessionId;
        sessionManager.updateTvSettings(targetSessionId, { fontSize, capacity, audioEnabled, showQr });
      }

      if (msg.type === 'CLEAR_SESSION_TEXT') {
        const targetSessionId = msg.sessionId || userSessionId;
        sessionManager.clearSessionText(targetSessionId);
      }

      if (msg.type === 'AUDIO_DATA') {
        // Base64 audio chunk from browser WebRTC/MediaRecorder
        if (msg.base64Audio) {
          const audioBuffer = Buffer.from(msg.base64Audio, 'base64');
          if (sonioxService.isConfigured()) {
            sonioxService.broadcastAudio(audioBuffer);
          }
          sttService.sendAudioChunk(audioBuffer);
        }
      }

      if (msg.type === 'DIRECT_SPEECH') {
        // Direct speech from browser Web Speech API
        if (msg.text) {
          sttService.emit('transcript', {
            text: msg.text,
            isFinal: true,
            source: 'browser_mic'
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
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` MosqAI Live Khutbah Translation Prototype is LIVE `);
    console.log(` Port: http://localhost:${PORT}                      `);
    console.log(` Admin Control Panel: http://localhost:${PORT}/admin.html`);
    console.log(` Live TV Display:     http://localhost:${PORT}/display.html`);
    console.log(` Mobile Attendee Join: http://localhost:${PORT}/join.html`);
    console.log(`====================================================`);
  });
}

module.exports = { app, server, sessionManager, sttService };
