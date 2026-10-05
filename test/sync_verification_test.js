const assert = require('assert');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionManager } = require('../server/sessionManager');
const { TranslationService } = require('../server/services/translationService');

async function runTest() {
  console.log('Testing Admin <-> Display TV synchronization across canonical session IDs...');

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const sessionManager = new SessionManager();
  const translationService = new TranslationService();

  // Create default canonical session
  await sessionManager.createSession({
    sessionId: 'myo-youth',
    mosqueName: 'MYO Youth Center',
    primaryLanguage: 'ar'
  });

  app.post('/api/session/:id/start', (req, res) => {
    const session = sessionManager.startSession(req.params.id);
    res.json({ success: true, session });
  });

  app.post('/api/session/:id/pause', (req, res) => {
    const session = sessionManager.pauseSession(req.params.id);
    res.json({ success: true, session });
  });

  app.post('/api/session/:id/end', (req, res) => {
    const session = sessionManager.endSession(req.params.id);
    res.json({ success: true, session });
  });

  app.post('/api/session/:id/clear', (req, res) => {
    const session = sessionManager.clearSessionText(req.params.id);
    res.json({ success: true, session });
  });

  app.post('/api/session/:id/inject-text', async (req, res) => {
    const { text, inputLang = 'auto' } = req.body;
    const targetSessionId = sessionManager.getCanonicalId(req.params.id);
    const session = sessionManager.getSession(targetSessionId);
    
    const translations = await translationService.translateMultiple(text, ['en', 'uz', 'bn', 'ur', 'fr', 'zh', 'tr'], inputLang);
    sessionManager.broadcastTranslations(targetSessionId, {
      arabicText: text,
      translations,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, translations });
  });

  wss.on('connection', (ws) => {
    let userSessionId = 'myo-youth';
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'JOIN_ROOM') {
        userSessionId = sessionManager.getCanonicalId(msg.sessionId);
        sessionManager.addSubscriber(userSessionId, ws, {
          role: msg.role,
          language: msg.language || 'en',
          clientId: msg.clientId
        });
        ws.send(JSON.stringify({
          type: 'JOINED_SUCCESS',
          sessionId: userSessionId,
          session: sessionManager.getSession(userSessionId)
        }));
      }
    });
  });

  const TEST_PORT = 3922;
  await new Promise(r => server.listen(TEST_PORT, r));

  // 1. Admin joins room using hex slug 'myo-youth-8f3a9e'
  const adminWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
  await new Promise(r => adminWs.on('open', r));
  adminWs.send(JSON.stringify({
    type: 'JOIN_ROOM',
    sessionId: 'myo-youth-8f3a9e',
    role: 'admin'
  }));

  // 2. Display TV joins room using default 'myo-youth'
  const tvWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
  await new Promise(r => tvWs.on('open', r));
  tvWs.send(JSON.stringify({
    type: 'JOIN_ROOM',
    sessionId: 'myo-youth',
    role: 'tv',
    language: 'en'
  }));

  const tvMessages = [];
  tvWs.on('message', (raw) => {
    tvMessages.push(JSON.parse(raw.toString()));
  });

  await new Promise(r => setTimeout(r, 100));

  // Test Step 1: Admin clicks START for 'myo-youth-8f3a9e'
  console.log('Step 1: Admin starts session via /api/session/myo-youth-8f3a9e/start...');
  await fetch(`http://localhost:${TEST_PORT}/api/session/myo-youth-8f3a9e/start`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 100));

  const startMsg = tvMessages.find(m => m.type === 'SESSION_STATUS' && m.status === 'active');
  assert(startMsg, 'Display TV did not receive active status update when Admin started session!');
  console.log('✔ Display TV received SESSION_STATUS: active');

  // Test Step 2: Admin clicks PAUSE for 'myo-youth-8f3a9e'
  console.log('Step 2: Admin pauses session via /api/session/myo-youth-8f3a9e/pause...');
  await fetch(`http://localhost:${TEST_PORT}/api/session/myo-youth-8f3a9e/pause`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 100));

  const pauseMsg = tvMessages.find(m => m.type === 'SESSION_STATUS' && m.status === 'paused');
  assert(pauseMsg, 'Display TV did not receive paused status update when Admin paused session!');
  console.log('✔ Display TV received SESSION_STATUS: paused');

  // Test Step 3: Admin speaks / injects text into 'myo-youth-8f3a9e'
  console.log('Step 3: Admin speaks into microphone / injects text into myo-youth-8f3a9e...');
  await fetch(`http://localhost:${TEST_PORT}/api/session/myo-youth-8f3a9e/inject-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'إن الحمد لله نحمده ونستعينه', inputLang: 'auto' })
  });
  await new Promise(r => setTimeout(r, 300));

  const subtitleMsg = tvMessages.find(m => m.type === 'LIVE_SUBTITLE');
  assert(subtitleMsg, 'Display TV did not receive LIVE_SUBTITLE when Admin spoke/injected text!');
  assert(subtitleMsg.arabic.includes('الحمد لله'), 'Subtitle text mismatch');
  console.log('✔ Display TV received LIVE_SUBTITLE:', subtitleMsg.arabic);

  // Test Step 4: Admin clears text
  console.log('Step 4: Admin clears screen text via /api/session/myo-youth-8f3a9e/clear...');
  await fetch(`http://localhost:${TEST_PORT}/api/session/myo-youth-8f3a9e/clear`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 100));

  const clearMsg = tvMessages.find(m => m.type === 'SESSION_CLEAR_TEXT');
  assert(clearMsg, 'Display TV did not receive SESSION_CLEAR_TEXT!');
  console.log('✔ Display TV received SESSION_CLEAR_TEXT');

  // Test Step 5: Admin ends session
  console.log('Step 5: Admin ends session via /api/session/myo-youth-8f3a9e/end...');
  await fetch(`http://localhost:${TEST_PORT}/api/session/myo-youth-8f3a9e/end`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 100));

  const endMsg = tvMessages.find(m => m.type === 'SESSION_STATUS' && m.status === 'ended');
  assert(endMsg, 'Display TV did not receive ended status update!');
  console.log('✔ Display TV received SESSION_STATUS: ended');

  adminWs.close();
  tvWs.close();
  server.close();
  console.log('🎉 ALL SYNC AND TRANSLATION CHECKS PASSED PERFECTLY!');
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
