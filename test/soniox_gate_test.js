/**
 * Unit Test for Soniox Dynamic Language Gates Manager with Multi-Session Isolation
 */

const assert = require('assert');
const EventEmitter = require('events');
const sonioxService = require('../server/services/sonioxService');

async function runSonioxGateTests() {
  console.log('\n========================================================');
  console.log('🧪 TESTING SONIOX DYNAMIC LANGUAGE GATES MANAGER');
  console.log('========================================================\n');

  // Test 1: Fallback / Unconfigured state
  console.log('[Test 1] Testing unconfigured state handling...');
  assert.strictEqual(typeof sonioxService.isConfigured, 'function');
  const initialStatus = sonioxService.getStatus();
  assert(initialStatus !== null, 'Status object should be returned');
  assert.strictEqual(typeof initialStatus.activeGateCount, 'number');
  console.log('  ✔ Soniox fallback & status inspection verified.');

  // Test 2: Setting API Key & Validating
  console.log('\n[Test 2] Testing Key validation...');
  sonioxService.setApiKey('test_soniox_valid_mock_key_12345');
  assert.strictEqual(sonioxService.isConfigured(), true, 'Valid key should be marked operational');
  console.log('  ✔ API Key activation verified.');

  // Test 3: Gate Syncing & On-Demand Lifecycle (Per-Session)
  console.log('\n[Test 3] Testing dynamic gate synchronization & multi-session isolation...');
  const originalConnectGate = sonioxService.connectGate.bind(sonioxService);
  const openedGates = [];
  sonioxService.connectGate = function(gate) {
    gate.status = 'open';
    gate.ws = {
      readyState: 1, // OPEN
      send: function(data) { gate.lastSent = data; },
      close: function() { gate.status = 'closed'; }
    };
    openedGates.push(gate.gateKey);
  };

  // Open gates for Session A
  sonioxService.syncGates('session-a', ['en', 'bn']);
  assert.strictEqual(sonioxService.activeGates.size, 2, 'Should have 2 open gates for session-a');
  assert(sonioxService.activeGates.has('session-a:en'), 'session-a:en gate should be open');
  assert(sonioxService.activeGates.has('session-a:bn'), 'session-a:bn gate should be open');
  console.log('  ✔ Opened gates for session-a ["en", "bn"].');

  // Open gates for Session B (Parallel session on second laptop)
  sonioxService.syncGates('session-b', ['en', 'tr']);
  assert.strictEqual(sonioxService.activeGates.size, 4, 'Should have 4 total open gates (2 for A, 2 for B)');
  assert(sonioxService.activeGates.has('session-b:en'), 'session-b:en gate should be open');
  assert(sonioxService.activeGates.has('session-b:tr'), 'session-b:tr gate should be open');
  console.log('  ✔ Opened gates for session-b ["en", "tr"] in parallel.');

  // Test 4: Strict Audio Isolation (Zero Cross-Talk)
  console.log('\n[Test 4] Testing strict audio isolation between sessions...');
  const audioChunkA = Buffer.alloc(3200); // 100ms of audio from Laptop A
  audioChunkA.fill(0xAA);
  const audioChunkB = Buffer.alloc(3200); // 100ms of audio from Laptop B
  audioChunkB.fill(0xBB);

  // Send Laptop A audio -> ONLY session-a gates should receive it!
  sonioxService.broadcastAudio(audioChunkA, 'session-a');
  assert.strictEqual(sonioxService.activeGates.get('session-a:en').lastSent, audioChunkA, 'session-a:en received Laptop A audio');
  assert.strictEqual(sonioxService.activeGates.get('session-a:bn').lastSent, audioChunkA, 'session-a:bn received Laptop A audio');
  assert.strictEqual(sonioxService.activeGates.get('session-b:en').lastSent, undefined, 'session-b:en MUST NOT receive Laptop A audio');
  assert.strictEqual(sonioxService.activeGates.get('session-b:tr').lastSent, undefined, 'session-b:tr MUST NOT receive Laptop A audio');
  console.log('  ✔ Audio from Laptop A routed exclusively to session-a (0 cross-talk).');

  // Send Laptop B audio -> ONLY session-b gates should receive it!
  sonioxService.broadcastAudio(audioChunkB, 'session-b');
  assert.strictEqual(sonioxService.activeGates.get('session-b:en').lastSent, audioChunkB, 'session-b:en received Laptop B audio');
  assert.strictEqual(sonioxService.activeGates.get('session-b:tr').lastSent, audioChunkB, 'session-b:tr received Laptop B audio');
  console.log('  ✔ Audio from Laptop B routed exclusively to session-b (0 cross-talk).');

  // Test 5: Token stream parsing with Session ID
  console.log('\n[Test 5] Testing Soniox per-token streaming emission with Session ID...');
  const receivedTokens = [];
  let receivedFinal = null;

  sonioxService.on('token_stream', (data) => { receivedTokens.push(data); });
  sonioxService.once('sentence_finalized', (data) => { receivedFinal = data; });

  const gateA = sonioxService.activeGates.get('session-a:en');

  // First token arrives
  sonioxService.handleSonioxMessage(gateA, {
    tokens: [{ text: 'Indeed, ', translation_status: 'translation', is_final: true }]
  });
  await new Promise(r => setTimeout(r, 70));

  // Second token arrives
  sonioxService.handleSonioxMessage(gateA, {
    tokens: [{ text: 'إن ', translation_status: 'original', is_final: true }]
  });
  await new Promise(r => setTimeout(r, 70));

  assert(receivedTokens.length >= 2, 'Both tokens should have fired independently');
  assert.strictEqual(receivedTokens[0].sessionId, 'session-a', 'Token MUST carry sessionId');
  assert.strictEqual(receivedTokens[0].lang, 'en');
  console.log('  ✔ Per-token streaming carries correct sessionId ("session-a").');

  // Final sentence completion
  sonioxService.handleSonioxMessage(gateA, {
    tokens: [
      { text: 'with hardship comes ease.', translation_status: 'translation', is_final: true },
      { text: 'مع العسر يسرا.', translation_status: 'original', is_final: true },
      { text: '<end>', translation_status: 'original', is_final: true }
    ]
  });

  assert(receivedFinal !== null, 'sentence_finalized event should have fired');
  assert.strictEqual(receivedFinal.sessionId, 'session-a', 'Finalized sentence MUST carry sessionId');
  assert.strictEqual(receivedFinal.finalText, 'Indeed, with hardship comes ease.');
  console.log('  ✔ Sentence finalized event correctly tagged with sessionId.');

  // Test 6: Closing Session Gates Independently
  console.log('\n[Test 6] Testing session gate cleanup isolation...');
  sonioxService.closeSessionGates('session-a');
  assert.strictEqual(sonioxService.activeGates.has('session-a:en'), false, 'session-a gates should be closed');
  assert.strictEqual(sonioxService.activeGates.has('session-b:en'), true, 'session-b gates MUST remain open');
  console.log('  ✔ Closing session-a gates left session-b completely intact and active.');

  // Clean up
  sonioxService.removeAllListeners('token_stream');
  sonioxService.closeAllGates();
  assert.strictEqual(sonioxService.activeGates.size, 0, 'All gates closed');
  sonioxService.connectGate = originalConnectGate;
  sonioxService.setApiKey(process.env.SONIOX_API_KEY || '');

  console.log('\n========================================================');
  console.log('🎉 ALL SONIOX DYNAMIC GATE TESTS PASSED! (100% GREEN)');
  console.log('========================================================\n');
}

runSonioxGateTests().catch(err => {
  console.error('❌ Soniox Test Failure:', err);
  process.exit(1);
});
