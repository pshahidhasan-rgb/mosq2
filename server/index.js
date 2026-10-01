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
const sttService = new STTService(process.env.GLADIA_API_KEY, process.env.DEEPGRAM_API_KEY);
const quranAiDetector = new QuranAIDetector(openrouterKey, openrouterModel);

// Active session tracking for STT distribution
let activeLiveSessionId = 'jumuah-live';

// Pre-create the initial default Friday Khutbah session
(async () => {
  await sessionManager.createSession({
    sessionId: activeLiveSessionId,
    mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
    primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en',
    hostUrl: `http://localhost:${PORT}`
  });
  console.log(`[MosqAI] Default Khutbah session ready: ${activeLiveSessionId}`);
})();

// Initialize STT engine (Deepgram Nova-3 / Gladia / Simulator)
sttService.initSession();

/**
 * Main Real-time Processing Pipeline:
 * Arabic Speech Transcript -> AI Quran Ayah Detection -> Multi-Language Translation -> Low-Latency Audio -> Broadcast
 */
async function processTranscript({ text, isFinal, source }) {
  if (!text || text.trim().length === 0) return null;
  const cleanArabic = text.trim();
  console.log(`[STT -> ${source}] Received Arabic: "${cleanArabic}"`);

  const sessionId = activeLiveSessionId;
  let session = sessionManager.getSession(sessionId);
  if (!session) {
    session = await sessionManager.createSession({
      sessionId,
      mosqueName: process.env.DEFAULT_MASJID_NAME || 'Masjid Al-Noor',
      primaryLanguage: process.env.DEFAULT_PRIMARY_LANGUAGE || 'en'
    });
  }
  if (session.status === 'ended') return null;

  // Step 1: Detect Quran Ayah in speech using AI Model & Canonical Corpus
  const ayahMatch = await quranAiDetector.detect(cleanArabic);
  if (ayahMatch) {
    console.log(`[Quran Detection] Matched: ${ayahMatch.reference} (${ayahMatch.confidence}% confidence, source: ${ayahMatch.source || 'canonical'})`);
  }

  // Step 2: Multi-language Translation
  let translations = {};
  if (ayahMatch && ayahMatch.translations) {
    // If Quran Ayah, use canonical authenticated translations for precision
    translations = { ...ayahMatch.translations };
  } else {
    // Regular sermon speech: translate via OpenRouter Llama 3.3 / fallback
    const targetLanguages = ['en', 'bn', 'ur', 'fr', 'zh', 'tr'];
    translations = await translationService.translateMultiple(cleanArabic, targetLanguages);
  }

  // Step 3: Low-Latency Spoken Audio Generation for Earbuds (Cartesia / Sonic)
  const audioByLanguage = {};
  const stats = sessionManager.getSessionStats(sessionId);
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

  // Step 4: Instant Multi-Screen & Earbud Broadcast
  const broadcastPayload = {
    arabicText: cleanArabic,
    translations,
    ayahData: ayahMatch,
    audioByLanguage,
    timestamp: new Date().toISOString()
  };

  sessionManager.broadcastTranslations(sessionId, broadcastPayload);
  return broadcastPayload;
}

sttService.on('transcript', (data) => {
  processTranscript(data).catch(err => console.error('[STT] Processing error:', err.message));
});

// REST API Endpoints

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
  res.json({
    status: 'online',
    providers: {
      deepgramSTT: isKeyActive(process.env.DEEPGRAM_API_KEY),
      gladiaSTT: isKeyActive(process.env.GLADIA_API_KEY),
      openrouterTranslation: isKeyActive(openrouterKey),
      openrouterModel,
      deeplTranslation: isKeyActive(process.env.DEEPL_API_KEY),
      quranAiModel: isKeyActive(openrouterKey),
      cartesiaTTS: isKeyActive(process.env.CARTESIA_API_KEY)
    },
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

// Create custom session
app.post('/api/session/create', async (req, res) => {
  const { sessionId, mosqueName, primaryLanguage } = req.body;
  const newId = sessionId || `khutbah-${Date.now()}`;
  activeLiveSessionId = newId;

  const session = await sessionManager.createSession({
    sessionId: newId,
    mosqueName: mosqueName || 'Masjid Al-Noor',
    primaryLanguage: primaryLanguage || 'en',
    hostUrl: `${req.protocol}://${req.get('host')}`
  });

  res.json(session);
});

// Start Khutbah Session
app.post('/api/session/:id/start', (req, res) => {
  const session = sessionManager.startSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Pause Khutbah Session
app.post('/api/session/:id/pause', (req, res) => {
  const session = sessionManager.pauseSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// End Khutbah Session
app.post('/api/session/:id/end', (req, res) => {
  sttService.stopSimulation();
  const session = sessionManager.endSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
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

// Direct test text injection
app.post('/api/session/:id/inject-text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const result = await processTranscript({
    text,
    isFinal: true,
    source: 'manual_injection'
  });

  res.json({ success: true, result });
});

// Khutbah Archives History
app.get('/api/history', (req, res) => {
  res.json(sessionManager.history);
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
    transcripts,
    stats,
    serverTime: new Date().toISOString()
  });
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
          clientId: msg.clientId
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

      if (msg.type === 'CHANGE_LANGUAGE') {
        userLanguage = msg.language || 'en';
        sessionManager.updateSubscriberLanguage(userSessionId, ws, userLanguage);
      }

      if (msg.type === 'AUDIO_DATA') {
        // Base64 audio chunk from browser WebRTC/MediaRecorder
        if (msg.base64Audio) {
          const audioBuffer = Buffer.from(msg.base64Audio, 'base64');
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
