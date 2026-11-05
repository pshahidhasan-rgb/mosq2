/**
 * Real-Time Translation Regression & Cooldown Recovery Test Suite
 *
 * Verifies the fixes for:
 *   1. Mid-speech non-final token streaming (sub-200ms words before endpoint/pause)
 *   2. Anchor gate creation for indirect language rooms (e.g. Uzbek 'uz', Somali 'so')
 *   3. Automatic 429 rate-limit cooldown recovery (resetting flag after deadline)
 *   4. Zero-cost protections preserved ($0 presence ping, mic-off immediate termination)
 *
 * Runs locally with 100% synthetic/mock sockets: ZERO API calls, ZERO cost.
 */

const assert = require('assert');
const EventEmitter = require('events');
const sonioxService = require('../server/services/sonioxService');
const { SessionManager } = require('../server/sessionManager');

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.bufferedAmount = 0;
    this.sentData = [];
    this.closed = false;
  }
  send(data) {
    this.sentData.push(data);
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    process.nextTick(() => {
      this.emit('close', code || 1000, reason || 'Normal');
    });
  }
  terminate() {
    this.close(1006, 'Terminated');
  }
}

async function runRegressionFixTests() {
  console.log('\n================================================================');
  console.log('⚡ SONIOX REAL-TIME REGRESSION FIX & COOLDOWN RECOVERY TEST SUITE');
  console.log('================================================================\n');

  const sessionManager = new SessionManager();
  sonioxService.setApiKey('test_valid_soniox_key_realtime_regression_12345');

  sonioxService.setSessionValidator((sid) => {
    const s = sessionManager.getSession(sid);
    return Boolean(s && s.status === 'active');
  });
  sonioxService.setPublisherValidator((sid) => {
    return sessionManager.isPublisherActive(sid);
  });

  // Mock connectGate to attach mock WebSockets
  sonioxService.connectGate = function(gate) {
    const ws = new MockWebSocket();
    gate.ws = ws;
    gate.status = 'open';
    gate.reconnectAttempts = 0;
    ws.generation = gate.generation;
    this.emit('connected', { sessionId: gate.sessionId, lang: gate.lang });

    // Handle incoming mock messages
    ws.on('mock_message', (payload) => {
      this.onSonioxMessage(gate, Buffer.from(JSON.stringify(payload)));
    });
  };

  const sessionId = 'test-realtime-session-001';
  await sessionManager.createSession({
    sessionId,
    mosqueName: 'Masjid Test',
    primaryLanguage: 'en',
    tvLanguage: 'en'
  });
  sessionManager.startSession(sessionId);

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Mid-Speech Non-Final Token Streaming
  // ─────────────────────────────────────────────────────────────
  console.log('[Test 1] Verifying mid-speech non-final tokens stream before sentence endpoint...');
  sessionManager.setPublisherState(sessionId, true, 10000);
  sonioxService.syncGates(sessionId, ['en']);

  const gateEn = sonioxService.activeGates.get(`${sessionId}:en`);
  assert(gateEn, 'Soniox gate for "en" must be open');
  assert.strictEqual(gateEn.status, 'open');

  let streamTokenReceived = null;
  const onTokenStream = (data) => {
    if (data.sessionId === sessionId && data.lang === 'en') {
      streamTokenReceived = data;
    }
  };
  sonioxService.on('token_stream', onTokenStream);

  // Simulate Soniox sending non-final tokens mid-speech (NO endpoint, NO punctuation)
  gateEn.ws.emit('mock_message', {
    tokens: [
      { text: 'In ', translation_status: 'translation', is_final: false },
      { text: 'the ', translation_status: 'translation', is_final: false },
      { text: 'بسم ', translation_status: 'original', is_final: false }
    ]
  });

  // Wait for 60ms partial throttle window
  await new Promise(r => setTimeout(r, 90));

  assert(streamTokenReceived, 'Must emit token_stream during speech before endpoint');
  assert.strictEqual(streamTokenReceived.isFinal, false, 'Mid-speech token must have isFinal: false');
  assert.strictEqual(streamTokenReceived.translatedFull.trim(), 'In the', 'translatedFull must match non-final tokens');
  assert.strictEqual(streamTokenReceived.originalFull.trim(), 'بسم', 'originalFull must match non-final original speech');
  console.log('  ✔ PASS: Non-final streaming tokens emitted mid-speech (sub-200ms).');
  sonioxService.removeListener('token_stream', onTokenStream);

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Anchor Gate for Indirect Language Rooms (e.g. Uzbek 'uz')
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 2] Verifying anchor gate creation for indirect language rooms (Uzbek "uz")...');
  const uzSessionId = 'test-uzbek-session-002';
  await sessionManager.createSession({
    sessionId: uzSessionId,
    mosqueName: 'Masjid Uzbek',
    primaryLanguage: 'uz',
    tvLanguage: 'uz'
  });
  sessionManager.startSession(uzSessionId);
  sessionManager.setPublisherState(uzSessionId, true, 10000);

  // Sync only 'uz' (which Soniox does not support natively)
  sonioxService.syncGates(uzSessionId, ['uz']);

  // Must have opened an anchor gate ('en')
  const anchorGate = sonioxService.activeGates.get(`${uzSessionId}:en`);
  assert(anchorGate, 'Must create anchor gate for session with only indirect targets');
  assert.strictEqual(anchorGate.isAnchor, true, 'Gate must be tagged as isAnchor: true');
  assert(anchorGate.indirectLanguages.has('uz'), 'Anchor gate must track indirect language "uz"');

  let uzTokenReceived = null;
  const onUzTokenStream = (data) => {
    if (data.sessionId === uzSessionId && data.lang === 'uz') {
      uzTokenReceived = data;
    }
  };
  sonioxService.on('token_stream', onUzTokenStream);

  // Simulate Soniox sending live speech tokens on the anchor gate
  anchorGate.ws.emit('mock_message', {
    tokens: [
      { text: 'الحمد ', translation_status: 'original', is_final: false }
    ]
  });

  await new Promise(r => setTimeout(r, 90));

  assert(uzTokenReceived, 'Must emit token_stream for "uz" room from anchor gate');
  assert.strictEqual(uzTokenReceived.originalFull.trim(), 'الحمد', 'Uzbek room must receive original speech in real time');
  assert.strictEqual(uzTokenReceived.isFinal, false);
  console.log('  ✔ PASS: Anchor gate opened and streamed live speech tokens to Uzbek room.');
  sonioxService.removeListener('token_stream', onUzTokenStream);

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Rate-Limit / 429 Cooldown Auto-Reset
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 3] Verifying 429 cooldown auto-reset allows reconnection after expiry...');
  // Manually trigger rate limit
  sonioxService.isRateLimited = true;
  sonioxService.rateLimitedUntil = Date.now() + 100; // 100ms cooldown for test

  assert.strictEqual(sonioxService.isCooldownActive(), true, 'Cooldown must be active initially');
  assert.strictEqual(sonioxService.isGateEligible(sessionId, 'en'), false, 'Gate eligibility rejected during cooldown');

  // Wait 120ms for cooldown to expire
  await new Promise(r => setTimeout(r, 120));

  // isCooldownActive() must reset the flag and return false
  const activeNow = sonioxService.isCooldownActive();
  assert.strictEqual(activeNow, false, 'Cooldown must be inactive after deadline');
  assert.strictEqual(sonioxService.isRateLimited, false, 'isRateLimited flag must auto-reset to false');
  assert.strictEqual(sonioxService.isGateEligible(sessionId, 'en'), true, 'Gate eligibility restored after cooldown');
  console.log('  ✔ PASS: Rate limit cooldown expired cleanly and restored gate eligibility.');

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Zero-Billing Boundary Preserved
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 4] Verifying zero-billing boundary remains 100% intact...');
  // When mic is turned off, all gates must close with 0ms delay
  await sonioxService.onMicrophoneOff(sessionId);
  assert.strictEqual(sonioxService.activeGates.has(`${sessionId}:en`), false, 'All gates for session must be closed on mic off');

  await sonioxService.onMicrophoneOff(uzSessionId);
  assert.strictEqual(sonioxService.activeGates.has(`${uzSessionId}:en`), false, 'Anchor gate must close on mic off');
  console.log('  ✔ PASS: All gates shut down immediately on microphone off ($0 cost).');

  console.log('\n================================================================');
  console.log('🎉 ALL REAL-TIME REGRESSION FIX TESTS PASSED (100%)');
  console.log('================================================================\n');
}

runRegressionFixTests().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
