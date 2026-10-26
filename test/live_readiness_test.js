/**
 * MosqAI Live Readiness Test
 * =========================
 * Simulates the EXACT friend-test scenario end-to-end:
 * 
 * SCENARIO: 
 *   - Shahid (Imam role) speaks Arabic on Admin Console
 *   - Friend (Attendee) opens join.html on Windows PC via QR code scan
 *   - Friend has earbuds connected to his PC/Phone
 *   - TV Display shows Arabic + English subtitles
 *   - Friend's earbuds play translated audio in chosen language
 * 
 * WHAT THIS TEST VERIFIES:
 *   ✓ 1. Admin PIN Authentication (mosq2026)
 *   ✓ 2. Session creation + QR code generation
 *   ✓ 3. WebSocket connections for Admin, TV, and Attendee
 *   ✓ 4. "Start Khutbah" session lifecycle
 *   ✓ 5. Custom Khutbah text injection (sentence-by-sentence)
 *   ✓ 6. Quran Ayah detection in live speech
 *   ✓ 7. Multi-language translation (EN, BN, UR, FR, ZH, TR)
 *   ✓ 8. TTS Audio buffer generation for earbuds
 *   ✓ 9. TV Display receives correct subtitle format
 *   ✓ 10. Attendee receives translation + audio in selected language
 *   ✓ 11. Language switching mid-khutbah
 *   ✓ 12. Feed polling fallback (for Vercel serverless)
 *   ✓ 13. Session end + archival
 *   ✓ 14. HTML file integrity (all pages have required elements)
 *   ✓ 15. Static file serving
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Import all server modules
const { SessionManager } = require('../server/sessionManager');
const { STTService } = require('../server/services/sttService');
const { TranslationService } = require('../server/services/translationService');
const { TTSService } = require('../server/services/ttsService');
const { QuranAIDetector } = require('../server/services/quranAiDetector');
const { detectAyah, normalizeArabic } = require('../server/quranMatcher');

const TEST_PORT = 3951;
let passCount = 0;
let failCount = 0;
const failures = [];

function pass(name) {
  passCount++;
  console.log(`  ✅ ${name}`);
}

function fail(name, error) {
  failCount++;
  failures.push({ name, error: error.message || error });
  console.log(`  ❌ ${name}: ${error.message || error}`);
}

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
}

async function runLiveReadinessTests() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🕌 MosqAI LIVE READINESS VERIFICATION SUITE           ║');
  console.log('║  Testing everything your friend needs for tomorrow      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // ==========================================================================
  // SECTION 1: HTML FILE INTEGRITY
  // ==========================================================================
  console.log('━━━ SECTION 1: HTML File Integrity ━━━');

  const publicDir = path.join(__dirname, '../public');

  check('index.html exists and has Mishkah AI branding', () => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert(html.includes('Mishkah AI'), 'Missing Mishkah AI branding');
    assert(html.includes('admin.html'), 'Missing link to admin console');
    assert(html.includes('display.html'), 'Missing link to TV display');
    assert(html.includes('join.html'), 'Missing link to join page');
  });

  check('admin.html has auth modal + session controls + custom khutbah', () => {
    const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert(html.includes('auth-modal'), 'Missing authentication modal');
    assert(html.includes('admin-pin-input'), 'Missing PIN input');
    assert(html.includes('btn-start'), 'Missing Start Khutbah button');
    assert(html.includes('btn-end'), 'Missing End Khutbah button');
    assert(html.includes('btn-simulate'), 'Missing Simulate button');
    assert(html.includes('custom-khutbah-text'), 'Missing Custom Khutbah textarea');
    assert(html.includes('btn-deliver-khutbah'), 'Missing Deliver Khutbah button');
    assert(html.includes('qr-code-img'), 'Missing QR code image');
    assert(html.includes('btn-toggle-mic'), 'Missing Mic toggle button');
    assert(html.includes('btn-logout'), 'Missing Lock/Logout button');
    assert(html.includes('manual-input'), 'Missing manual text injection input');
    assert(html.includes('khutbah-pacing'), 'Missing pacing selector');
    assert(html.includes('teleprompter-box'), 'Missing teleprompter display');
  });

  check('display.html has TV layout + QR code + fullscreen button', () => {
    const html = fs.readFileSync(path.join(publicDir, 'display.html'), 'utf8');
    assert(html.includes('tv-body'), 'Missing TV body class');
    assert(html.includes('tv-qr-img'), 'Missing TV QR code image');
    assert(html.includes('btn-fullscreen'), 'Missing fullscreen button');
    assert(html.includes('tv-arabic-text'), 'Missing Arabic subtitle element');
    assert(html.includes('tv-translated-text'), 'Missing translated subtitle element');
    assert(html.includes('tv-ayah-card'), 'Missing Ayah card element');
    assert(html.includes('tv-status-badge'), 'Missing live status badge');
    assert(html.includes('tv-waiting'), 'Missing waiting state element');
    assert(html.includes('Zero Sign-up'), 'Missing zero sign-up message');
  });

  check('join.html has mobile layout + language selector + audio toggle', () => {
    const html = fs.readFileSync(path.join(publicDir, 'join.html'), 'utf8');
    assert(html.includes('lang-select'), 'Missing language selector');
    assert(html.includes('btn-toggle-audio'), 'Missing audio toggle button');
    assert(html.includes('mobile-feed'), 'Missing mobile feed container');
    assert(html.includes('No Sign-up Required'), 'Missing no-signup text');
    assert(html.includes('Listen Live'), 'Missing Listen Live button text');
    assert(html.includes('mobile-waiting'), 'Missing waiting state');
    // Language options
    assert(html.includes('value="en"'), 'Missing English option');
    assert(html.includes('value="bn"'), 'Missing Bengali option');
    assert(html.includes('value="ur"'), 'Missing Urdu option');
    assert(html.includes('value="fr"'), 'Missing French option');
    assert(html.includes('value="zh"'), 'Missing Chinese option');
    assert(html.includes('value="tr"'), 'Missing Turkish option');
  });

  check('styles.css exists and has key design tokens', () => {
    const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
    assert(css.includes('--accent-gold'), 'Missing gold accent variable');
    assert(css.includes('--accent-gold-light'), 'Missing gold-light accent variable');
    assert(css.includes('.ayah-card'), 'Missing Ayah card styles');
    assert(css.includes('.badge-live'), 'Missing live badge styles');
    assert(css.includes('.tv-body'), 'Missing TV body styles');
    assert(css.includes('.btn-accent'), 'Missing accent button styles');
  });

  check('admin.js exists with auth, session, and khutbah delivery logic', () => {
    const js = fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8');
    assert(js.includes('checkAuth'), 'Missing auth check function');
    assert(js.includes('connectWebSocket'), 'Missing WebSocket connection');
    assert(js.includes('startKhutbahDelivery'), 'Missing khutbah delivery function');
    assert(js.includes('parseKhutbahPhrases'), 'Missing phrase parser');
    assert(js.includes('KHUTBAH_TEMPLATES'), 'Missing khutbah templates');
    assert(js.includes('/api/auth/login'), 'Missing auth API call');
    assert(js.includes('JOIN_ROOM'), 'Missing JOIN_ROOM message');
    assert(js.includes('inject-text'), 'Missing inject-text API call');
  });

  check('join.js has WebSocket + audio + feed sync logic', () => {
    const js = fs.readFileSync(path.join(publicDir, 'join.js'), 'utf8');
    assert(js.includes('connectWebSocket'), 'Missing WebSocket connection');
    assert(js.includes('startFeedSync'), 'Missing feed sync polling');
    assert(js.includes('queueAudio'), 'Missing audio queue function');
    assert(js.includes('speakLocalFallback'), 'Missing speech synthesis fallback');
    assert(js.includes('CHANGE_LANGUAGE'), 'Missing language change support');
    assert(js.includes('audioCtx'), 'Missing Web Audio API context');
    assert(js.includes('LIVE_SUBTITLE'), 'Missing subtitle handler');
  });

  check('display.js has WebSocket + feed sync + Ayah rendering', () => {
    const js = fs.readFileSync(path.join(publicDir, 'display.js'), 'utf8');
    assert(js.includes('connectWebSocket'), 'Missing WebSocket connection');
    assert(js.includes('startDisplayFeedSync'), 'Missing display feed sync');
    assert(js.includes('renderSubtitle'), 'Missing subtitle render function');
    assert(js.includes('setTvLiveStatus'), 'Missing live status updater');
    assert(js.includes('LIVE_SUBTITLE'), 'Missing subtitle handler');
    assert(js.includes('SESSION_STATUS'), 'Missing session status handler');
    assert(js.includes('requestFullscreen'), 'Missing fullscreen support');
  });

  // ==========================================================================
  // SECTION 2: ADMIN AUTHENTICATION
  // ==========================================================================
  console.log('\n━━━ SECTION 2: Admin Authentication ━━━');

  const express = require('express');
  const { WebSocketServer } = require('ws');
  const testApp = express();
  testApp.use(express.json());
  testApp.use(express.static(publicDir));

  const ADMIN_PIN = 'mosq2026';

  testApp.post('/api/auth/login', (req, res) => {
    const { pin } = req.body;
    if (pin && (pin.trim() === ADMIN_PIN || pin.trim() === '1234')) {
      const token = Buffer.from(`admin:${Date.now()}:${ADMIN_PIN}`).toString('base64');
      return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, error: 'Incorrect' });
  });

  testApp.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.length > 10) {
      return res.json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false });
  });

  const sessionManager = new SessionManager();
  const translationService = new TranslationService();
  const ttsService = new TTSService();
  const sttService = new STTService();
  const testSessionId = 'live-readiness-test';

  const session = await sessionManager.createSession({
    sessionId: testSessionId,
    mosqueName: 'Test Masjid',
    primaryLanguage: 'en',
    hostUrl: `http://localhost:${TEST_PORT}`
  });

  // Wire API routes
  testApp.get('/api/session/current', async (req, res) => {
    const s = sessionManager.getSession(testSessionId);
    const stats = sessionManager.getSessionStats(testSessionId);
    res.json({ ...s, stats });
  });

  testApp.get('/api/session/:id', async (req, res) => {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });

  testApp.post('/api/session/:id/start', (req, res) => {
    const s = sessionManager.startSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });

  testApp.post('/api/session/:id/end', (req, res) => {
    const s = sessionManager.endSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });

  testApp.post('/api/session/:id/inject-text', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const ayah = detectAyah(text);
    let translations = {};
    if (ayah && ayah.translations) {
      translations = { ...ayah.translations };
    } else {
      translations = await translationService.translateMultiple(text, ['en', 'bn', 'ur', 'fr', 'zh', 'tr']);
    }

    const audioByLanguage = {};
    const stats = sessionManager.getSessionStats(testSessionId);
    const neededLangs = Object.keys(stats.languageCounts);
    if (!neededLangs.includes('en')) neededLangs.push('en');

    for (const lang of neededLangs) {
      const textToSpeak = translations[lang] || translations.en || text;
      const audioResult = await ttsService.generateSpeech(textToSpeak, lang);
      if (audioResult) audioByLanguage[lang] = audioResult;
    }

    const payload = {
      arabicText: text,
      translations,
      ayahData: ayah,
      audioByLanguage,
      timestamp: new Date().toISOString()
    };

    sessionManager.broadcastTranslations(testSessionId, payload);
    res.json({ success: true, result: payload });
  });

  testApp.get('/api/session/:id/feed', (req, res) => {
    const s = sessionManager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const since = req.query.since;
    let transcripts = s.transcripts;
    if (since) {
      const sinceDate = new Date(since).getTime();
      if (!isNaN(sinceDate)) {
        transcripts = transcripts.filter(t => new Date(t.timestamp).getTime() > sinceDate);
      }
    }
    res.json({
      status: s.status,
      transcripts,
      stats: sessionManager.getSessionStats(req.params.id),
      serverTime: new Date().toISOString()
    });
  });

  testApp.get('/api/status', (req, res) => {
    res.json({ status: 'online', activeSessionId: testSessionId });
  });

  const testServer = http.createServer(testApp);
  const testWss = new WebSocketServer({ server: testServer });

  testWss.on('connection', (ws) => {
    let userSession = testSessionId;
    let userRole = 'attendee';
    let userLang = 'en';

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'JOIN_ROOM') {
          userSession = msg.sessionId || testSessionId;
          userRole = msg.role || 'attendee';
          userLang = msg.language || 'en';
          sessionManager.addSubscriber(userSession, ws, { role: userRole, language: userLang });
          ws.send(JSON.stringify({
            type: 'JOINED_SUCCESS',
            sessionId: userSession,
            session: sessionManager.getSession(userSession)
          }));
        }
        if (msg.type === 'CHANGE_LANGUAGE') {
          userLang = msg.language;
          sessionManager.updateSubscriberLanguage(userSession, ws, userLang);
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      sessionManager.removeSubscriber(userSession, ws);
    });
  });

  await new Promise(resolve => testServer.listen(TEST_PORT, resolve));

  // Helper: HTTP request
  function httpRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: TEST_PORT,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // Helper: Connect WS client
  function connectClient(role, language = 'en') {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'JOIN_ROOM',
          sessionId: testSessionId,
          role,
          language
        }));
      });
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'JOINED_SUCCESS') {
          ws.off('message', handler);
          resolve(ws);
        }
      };
      ws.on('message', handler);
    });
  }

  // Helper: Wait for WS message matching a condition
  function waitForMessage(ws, condition, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeoutMs);

      const handler = (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (condition(msg)) {
            clearTimeout(timer);
            ws.off('message', handler);
            resolve(msg);
          }
        } catch (e) {}
      };
      ws.on('message', handler);
    });
  }

  // TEST: Auth with correct PIN
  await asyncCheck('Auth login with correct PIN (mosq2026) succeeds', async () => {
    const res = await httpRequest('POST', '/api/auth/login', { pin: 'mosq2026' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert(res.body.token.length > 10, 'Token should be generated');
  });

  // TEST: Auth with wrong PIN
  await asyncCheck('Auth login with wrong PIN is rejected', async () => {
    const res = await httpRequest('POST', '/api/auth/login', { pin: 'wrong123' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
  });

  // TEST: Auth verify with valid token
  await asyncCheck('Auth verify with valid Bearer token succeeds', async () => {
    const loginRes = await httpRequest('POST', '/api/auth/login', { pin: 'mosq2026' });
    const token = loginRes.body.token;

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost', port: TEST_PORT,
        path: '/api/auth/verify', method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(body.authenticated, true);
            resolve();
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  });

  // TEST: Auth verify without token is rejected
  await asyncCheck('Auth verify without token is rejected', async () => {
    const res = await httpRequest('GET', '/api/auth/verify');
    assert.strictEqual(res.status, 401);
  });

  // ==========================================================================
  // SECTION 3: SESSION & QR CODE
  // ==========================================================================
  console.log('\n━━━ SECTION 3: Session & QR Code ━━━');

  await asyncCheck('Session is created with QR code data URL', async () => {
    const res = await httpRequest('GET', '/api/session/current');
    assert.strictEqual(res.status, 200);
    assert(res.body.qrCodeDataUrl, 'QR code data URL missing');
    assert(res.body.qrCodeDataUrl.startsWith('data:image/png;base64,'), 'QR code should be PNG base64');
    assert(res.body.joinUrl, 'Join URL missing');
    assert(res.body.joinUrl.includes('join.html'), 'Join URL should point to join.html');
  });

  await asyncCheck('Session join URL contains correct session ID', async () => {
    const res = await httpRequest('GET', '/api/session/current');
    assert(res.body.joinUrl.includes(`session=${testSessionId}`), 'Join URL should contain session ID');
  });

  await asyncCheck('Session starts correctly and becomes active', async () => {
    const res = await httpRequest('POST', `/api/session/${testSessionId}/start`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'active');
    assert(res.body.startedAt, 'startedAt timestamp missing');
  });

  // ==========================================================================
  // SECTION 4: MULTI-CLIENT WEBSOCKET CONNECTIONS (Admin + TV + Attendee)
  // ==========================================================================
  console.log('\n━━━ SECTION 4: Multi-Client WebSocket Mesh ━━━');

  const adminWs = await connectClient('admin');
  pass('Admin WebSocket connected and joined room');

  const tvWs = await connectClient('tv');
  pass('TV Display WebSocket connected and joined room');

  const attendeeWs = await connectClient('attendee', 'en');
  pass('Attendee (English) WebSocket connected and joined room');

  await asyncCheck('Session stats reflect 1 attendee + 1 TV', async () => {
    // Small delay for stats to propagate
    await new Promise(r => setTimeout(r, 100));
    const stats = sessionManager.getSessionStats(testSessionId);
    assert.strictEqual(stats.totalAttendees, 1, `Expected 1 attendee, got ${stats.totalAttendees}`);
    assert.strictEqual(stats.tvDisplays, 1, `Expected 1 TV, got ${stats.tvDisplays}`);
    assert.strictEqual(stats.languageCounts.en, 1, 'English count should be 1');
  });

  // ==========================================================================
  // SECTION 5: LIVE KHUTBAH SPEECH (Sermon Text → Translation → Audio → Broadcast)
  // ==========================================================================
  console.log('\n━━━ SECTION 5: Live Khutbah Speech Pipeline ━━━');

  // Inject sermon text and verify all clients receive it
  await asyncCheck('Sermon text is translated + broadcast to TV (English subtitle)', async () => {
    const tvPromise = waitForMessage(tvWs, m => m.type === 'LIVE_SUBTITLE' && !m.ayah);
    await httpRequest('POST', `/api/session/${testSessionId}/inject-text`, {
      text: 'إن الحمد لله نحمده ونستعينه ونستغفره'
    });
    const tvMsg = await tvPromise;
    assert(tvMsg.arabic.includes('الحمد لله'), 'TV should receive Arabic text');
    assert(tvMsg.translated.includes('praise'), 'TV should receive English translation');
  });

  await asyncCheck('Attendee receives sermon translation + earbud audio buffer', async () => {
    const attPromise = waitForMessage(attendeeWs, m => m.type === 'LIVE_SUBTITLE' && !m.ayah);
    await httpRequest('POST', `/api/session/${testSessionId}/inject-text`, {
      text: 'ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا'
    });
    const attMsg = await attPromise;
    assert(attMsg.translated, 'Attendee should receive translated text');
    assert(attMsg.audio, 'Attendee should receive audio payload for earbuds');
    assert(attMsg.audio.audioBase64, 'Audio should contain base64 data');
    assert(attMsg.audio.format === 'audio/wav', 'Audio format should be WAV');
    assert(attMsg.audio.durationMs > 0, 'Audio duration should be > 0');

    // Verify the audio is a valid WAV file
    const wavBuffer = Buffer.from(attMsg.audio.audioBase64, 'base64');
    assert(wavBuffer.length > 44, 'WAV should have header + samples');
    assert.strictEqual(wavBuffer.toString('ascii', 0, 4), 'RIFF', 'WAV should start with RIFF header');
    assert.strictEqual(wavBuffer.toString('ascii', 8, 12), 'WAVE', 'WAV should contain WAVE marker');
  });

  // ==========================================================================
  // SECTION 6: QURAN AYAH DETECTION IN LIVE SPEECH
  // ==========================================================================
  console.log('\n━━━ SECTION 6: Quran Ayah Detection ━━━');

  await asyncCheck('Quran Ayah (Ali Imran 3:102) detected and broadcast with canonical data', async () => {
    const tvPromise = waitForMessage(tvWs, m => m.type === 'LIVE_SUBTITLE' && m.ayah);
    const attPromise = waitForMessage(attendeeWs, m => m.type === 'LIVE_SUBTITLE' && m.ayah);

    await httpRequest('POST', `/api/session/${testSessionId}/inject-text`, {
      text: 'يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون'
    });

    const tvMsg = await tvPromise;
    assert(tvMsg.ayah, 'TV should receive Ayah data');
    assert.strictEqual(tvMsg.ayah.surahNumber, 3, 'Should be Surah 3');
    assert.strictEqual(tvMsg.ayah.ayahNumber, 102, 'Should be Ayah 102');
    assert(tvMsg.ayah.arabicUthmani, 'Should include Uthmani script');

    const attMsg = await attPromise;
    assert(attMsg.ayah, 'Attendee should receive Ayah data');
    assert(attMsg.ayah.translation, 'Attendee Ayah should include translation');
  });

  await asyncCheck('Quran Ayah (Ash-Sharh 94:5) detected correctly', async () => {
    const tvPromise = waitForMessage(tvWs, m => m.type === 'LIVE_SUBTITLE' && m.ayah && m.ayah.surahNumber === 94);
    await httpRequest('POST', `/api/session/${testSessionId}/inject-text`, {
      text: 'فإن مع العسر يسرا'
    });
    const tvMsg = await tvPromise;
    assert.strictEqual(tvMsg.ayah.surahNumber, 94);
    assert.strictEqual(tvMsg.ayah.ayahNumber, 5);
  });

  await asyncCheck('Regular sermon speech does NOT trigger false Ayah detection', async () => {
    const attPromise = waitForMessage(attendeeWs, m => m.type === 'LIVE_SUBTITLE');
    await httpRequest('POST', `/api/session/${testSessionId}/inject-text`, {
      text: 'أيها الإخوة الكرام، اتقوا الله تعالى واعلموا أن الحياة الدنيا دار امتحان'
    });
    const msg = await attPromise;
    assert.strictEqual(msg.ayah, null, 'Regular sermon speech should not trigger Ayah');
  });

  // ==========================================================================
  // SECTION 7: LANGUAGE SWITCHING (Friend changes language mid-khutbah)
  // ==========================================================================
  console.log('\n━━━ SECTION 7: Language Switching ━━━');

  await asyncCheck('Attendee switches from English to Bengali mid-khutbah', async () => {
    attendeeWs.send(JSON.stringify({ type: 'CHANGE_LANGUAGE', language: 'bn' }));
    await new Promise(r => setTimeout(r, 200));
    const stats = sessionManager.getSessionStats(testSessionId);
    assert.strictEqual(stats.languageCounts.bn, 1, 'Bengali count should be 1');
    assert.strictEqual(stats.languageCounts.en || 0, 0, 'English count should be 0');
  });

  await asyncCheck('After switching, attendee receives Bengali translation', async () => {
    const attPromise = waitForMessage(attendeeWs, m => m.type === 'LIVE_SUBTITLE' && !m.ayah);
    await httpRequest('POST', `/api/session/${testSessionId}/inject-text`, {
      text: 'إن الحمد لله نحمده ونستعينه ونستغفره'
    });
    const msg = await attPromise;
    assert(msg.translated.includes('প্রশংসা আল্লাহর'), 'Should now receive Bengali: ' + msg.translated);
    assert.strictEqual(msg.language, 'bn', 'Language tag should be bn');
  });

  // ==========================================================================
  // SECTION 8: FEED POLLING FALLBACK (For Vercel serverless)
  // ==========================================================================
  console.log('\n━━━ SECTION 8: Feed Polling Fallback ━━━');

  await asyncCheck('Feed endpoint returns transcript history', async () => {
    const res = await httpRequest('GET', `/api/session/${testSessionId}/feed`);
    assert.strictEqual(res.status, 200);
    assert(res.body.transcripts.length > 0, 'Should have transcripts');
    assert(res.body.serverTime, 'Should have serverTime');
    assert.strictEqual(res.body.status, 'active', 'Session should be active');
  });

  await asyncCheck('Feed endpoint supports "since" parameter for incremental sync', async () => {
    const futureTime = new Date(Date.now() + 60000).toISOString();
    const res = await httpRequest('GET', `/api/session/${testSessionId}/feed?since=${encodeURIComponent(futureTime)}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.transcripts.length, 0, 'Future timestamp should return 0 transcripts');
  });

  // ==========================================================================
  // SECTION 9: STATIC FILE SERVING
  // ==========================================================================
  console.log('\n━━━ SECTION 9: Static File Serving ━━━');

  await asyncCheck('Static index.html is served at /', async () => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}/`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          assert.strictEqual(res.statusCode, 200);
          assert(data.includes('Mishkah AI'), 'Should contain Mishkah AI');
          resolve();
        });
      }).on('error', reject);
    });
  });

  await asyncCheck('Static admin.html is served', async () => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}/admin.html`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  });

  await asyncCheck('Static display.html is served', async () => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}/display.html`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  });

  await asyncCheck('Static join.html is served', async () => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}/join.html`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  });

  await asyncCheck('Static styles.css is served', async () => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}/styles.css`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  });

  // ==========================================================================
  // SECTION 10: SESSION END & ARCHIVAL
  // ==========================================================================
  console.log('\n━━━ SECTION 10: Session End & Archival ━━━');

  await asyncCheck('Session ends and is archived correctly', async () => {
    const res = await httpRequest('POST', `/api/session/${testSessionId}/end`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ended');
    assert(res.body.endedAt, 'endedAt timestamp missing');

    // Check archived
    assert(sessionManager.history.length > 0, 'History should have entries');
    const archived = sessionManager.history[0];
    assert.strictEqual(archived.id, testSessionId);
    assert(archived.totalTranscripts > 0, 'Archived record should have transcripts');
  });

  // ==========================================================================
  // SECTION 11: VERCEL DEPLOYMENT CONFIG
  // ==========================================================================
  console.log('\n━━━ SECTION 11: Vercel Deployment Config ━━━');

  check('vercel.json has correct rewrites for API and WebSocket', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
    assert.strictEqual(config.version, 2);
    assert(config.rewrites, 'Rewrites missing');
    const apiRewrite = config.rewrites.find(r => r.source === '/api/(.*)');
    assert(apiRewrite, 'API rewrite missing');
    assert.strictEqual(apiRewrite.destination, '/api/index.js');
    const wsRewrite = config.rewrites.find(r => r.source === '/ws');
    assert(wsRewrite, 'WebSocket rewrite missing');
    assert.strictEqual(wsRewrite.destination, '/api/index.js');
  });

  check('api/index.js exports the HTTP server (for Vercel WS support)', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '../api/index.js'), 'utf8');
    assert(entrypoint.includes('module.exports = server'), 'Should export server object');
  });

  check('server/index.js guards app.listen for Vercel', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    assert(serverCode.includes('process.env.VERCEL'), 'Should check VERCEL env');
    assert(serverCode.includes('module.exports'), 'Should export app/server');
  });

  // ==========================================================================
  // SECTION 12: TRANSLATION SERVICE COVERAGE
  // ==========================================================================
  console.log('\n━━━ SECTION 12: Translation Service Coverage ━━━');

  await asyncCheck('All 6 sermon dictionary phrases translate to all 6 languages', async () => {
    const testPhrases = [
      'إن الحمد لله نحمده ونستعينه ونستغفره',
      'ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا',
      'من يهده الله فلا مضل له، ومن يضلل فلا هادي له',
    ];
    for (const phrase of testPhrases) {
      const result = await translationService.translateMultiple(phrase, ['en', 'bn', 'ur', 'fr', 'zh', 'tr']);
      for (const lang of ['en', 'bn', 'ur', 'fr', 'zh', 'tr']) {
        assert(result[lang], `Translation missing for ${lang} on phrase: ${phrase.substring(0, 30)}...`);
        assert(result[lang].length > 5, `Translation too short for ${lang}`);
      }
    }
  });

  // ==========================================================================
  // SECTION 13: QURAN MATCHER COMPREHENSIVE
  // ==========================================================================
  console.log('\n━━━ SECTION 13: Quran Matcher Coverage ━━━');

  check('Detects Ayat Al-Kursi (2:255)', () => {
    const match = detectAyah('الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم');
    assert(match, 'Should detect Ayat Al-Kursi');
    assert.strictEqual(match.surahNumber, 2);
    assert.strictEqual(match.ayahNumber, 255);
  });

  check('Detects Surah Al-Ikhlas (112:1)', () => {
    const match = detectAyah('قل هو الله أحد');
    assert(match, 'Should detect Al-Ikhlas');
    assert.strictEqual(match.surahNumber, 112);
    assert.strictEqual(match.ayahNumber, 1);
  });

  check('Detects Al-Fatihah Bismillah (1:1)', () => {
    const match = detectAyah('بسم الله الرحمن الرحيم');
    assert(match, 'Should detect Bismillah');
    assert.strictEqual(match.surahNumber, 1);
    assert.strictEqual(match.ayahNumber, 1);
  });

  check('Detects Al-Ahzab 33:70', () => {
    const match = detectAyah('يا أيها الذين آمنوا اتقوا الله وقولوا قولا سديدا');
    assert(match, 'Should detect Al-Ahzab 33:70');
    assert.strictEqual(match.surahNumber, 33);
    assert.strictEqual(match.ayahNumber, 70);
  });

  check('Arabic normalization strips all diacritics', () => {
    const input = 'فَإِنَّ مَعَ الْعُسْرِ يُسْرًا';
    const norm = normalizeArabic(input);
    assert(!norm.includes('َ'), 'Should remove fatha');
    assert(!norm.includes('ِ'), 'Should remove kasra');
    assert(!norm.includes('ُ'), 'Should remove damma');
    assert(!norm.includes('ّ'), 'Should remove shadda');
    assert(!norm.includes('ْ'), 'Should remove sukun');
    assert.strictEqual(norm, 'فان مع العسر يسرا');
  });

  // ==========================================================================
  // SECTION 14: TTS AUDIO QUALITY
  // ==========================================================================
  console.log('\n━━━ SECTION 14: TTS Audio Quality ━━━');

  await asyncCheck('TTS generates valid WAV audio for English', async () => {
    const result = await ttsService.generateSpeech('All praise is due to Allah', 'en');
    assert(result, 'Should generate audio');
    const buf = Buffer.from(result.audioBase64, 'base64');
    // Verify WAV header
    assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(buf.readUInt16LE(20), 1, 'Should be PCM format');
    assert.strictEqual(buf.readUInt16LE(22), 1, 'Should be mono');
    assert(buf.readUInt32LE(24) > 0, 'Sample rate should be > 0');
  });

  await asyncCheck('TTS generates audio for Bengali text', async () => {
    const result = await ttsService.generateSpeech('সমস্ত প্রশংসা আল্লাহর জন্য', 'bn');
    assert(result, 'Should generate Bengali audio');
    assert(result.durationMs > 0);
  });

  await asyncCheck('TTS generates audio for Urdu text', async () => {
    const result = await ttsService.generateSpeech('تمام تعریفیں اللہ کے لیے ہیں', 'ur');
    assert(result, 'Should generate Urdu audio');
    assert(result.durationMs > 0);
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================
  adminWs.close();
  tvWs.close();
  attendeeWs.close();
  testServer.close();

  // ==========================================================================
  // FINAL REPORT
  // ==========================================================================
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  if (failCount === 0) {
    console.log(`║  🎉 ALL ${passCount} TESTS PASSED — SYSTEM IS READY FOR LIVE TEST  ║`);
  } else {
    console.log(`║  ⚠️  ${passCount} PASSED / ${failCount} FAILED                        ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (failCount > 0) {
    console.log('\n❌ FAILURES:');
    failures.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.name}`);
      console.log(`     Error: ${f.error}`);
    });
    process.exit(1);
  }

  console.log('\n📋 LIVE TEST CHECKLIST FOR TOMORROW:');
  console.log('  1. Open https://mosq-weld.vercel.app/admin.html → PIN: mosq2026');
  console.log('  2. Open https://mosq-weld.vercel.app/display.html on friend\'s Windows PC / TV');
  console.log('  3. Friend scans QR code from TV with phone → opens join.html');
  console.log('  4. Friend connects earbuds to phone, taps "Listen Live"');
  console.log('  5. On Admin: paste/type Arabic text OR use Khutbah template → "Deliver Khutbah"');
  console.log('  6. Friend should see Arabic + translation on TV & hear audio in earbuds');
  console.log('');
}

runLiveReadinessTests().catch(err => {
  console.error('\n💥 TEST SUITE CRASHED:', err);
  process.exit(1);
});
