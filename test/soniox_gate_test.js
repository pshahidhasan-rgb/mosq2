/**
 * Unit Test for Soniox Dynamic Language Gates Manager
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

  // Test 3: Gate Syncing & On-Demand Lifecycle
  console.log('\n[Test 3] Testing dynamic gate synchronization...');
  // Mock gate connection creation to avoid external network dependencies in unit test
  const originalConnectGate = sonioxService.connectGate.bind(sonioxService);
  const openedLanguages = [];
  sonioxService.connectGate = function(gate) {
    gate.status = 'open';
    gate.ws = {
      readyState: 1, // OPEN
      send: function(data) { gate.lastSent = data; },
      close: function() { gate.status = 'closed'; }
    };
    openedLanguages.push(gate.lang);
  };

  // Sync to English (TV) and Bengali (1 attendee)
  sonioxService.syncGates(['en', 'bn']);
  assert.strictEqual(sonioxService.activeGates.size, 2, 'Should have 2 open gates');
  assert(sonioxService.activeGates.has('en'), 'English gate should be open');
  assert(sonioxService.activeGates.has('bn'), 'Bengali gate should be open');
  console.log('  ✔ Opened gates for active languages ["en", "bn"].');

  // Attendee switches or leaves: sync to English and Urdu
  sonioxService.syncGates(['en', 'ur']);
  assert.strictEqual(sonioxService.activeGates.size, 2, 'Should maintain 2 open gates');
  assert(sonioxService.activeGates.has('en'), 'English gate remains open');
  assert(sonioxService.activeGates.has('ur'), 'Urdu gate should be open');
  assert(!sonioxService.activeGates.has('bn'), 'Bengali gate should be closed ($0 cost)');
  console.log('  ✔ Stale Bengali gate automatically closed and Urdu gate opened.');

  // Test 4: Audio Fan-Out
  console.log('\n[Test 4] Testing audio fan-out...');
  const testPcmChunk = Buffer.alloc(3200); // 100ms of 16kHz PCM
  testPcmChunk.fill(0x55);
  sonioxService.broadcastAudio(testPcmChunk);

  assert.strictEqual(sonioxService.activeGates.get('en').lastSent, testPcmChunk, 'English gate received audio');
  assert.strictEqual(sonioxService.activeGates.get('ur').lastSent, testPcmChunk, 'Urdu gate received audio');
  console.log('  ✔ Audio successfully fanned out in parallel to all active gates.');

  // Test 5: Token stream parsing
  console.log('\n[Test 5] Testing Soniox streaming token parsing...');
  let receivedTokenStream = null;
  let receivedFinalized = null;

  sonioxService.once('token_stream', (data) => { receivedTokenStream = data; });
  sonioxService.once('sentence_finalized', (data) => { receivedFinalized = data; });

  const enGate = sonioxService.activeGates.get('en');
  sonioxService.handleSonioxMessage(enGate, {
    tokens: [
      { text: 'Indeed, ', translation_status: 'translation', is_final: false },
      { text: 'إن ', translation_status: 'original', is_final: false }
    ]
  });

  assert(receivedTokenStream !== null, 'token_stream event should have fired');
  assert.strictEqual(receivedTokenStream.lang, 'en');
  assert.strictEqual(receivedTokenStream.translatedChunk, 'Indeed, ');
  assert.strictEqual(receivedTokenStream.originalChunk, 'إن ');
  assert.strictEqual(receivedTokenStream.isFinal, false);
  console.log('  ✔ Word-by-word streaming token emitted correctly.');

  // Final sentence completion
  sonioxService.handleSonioxMessage(enGate, {
    tokens: [
      { text: 'with hardship comes ease.', translation_status: 'translation', is_final: true },
      { text: 'مع العسر يسرا.', translation_status: 'original', is_final: true }
    ]
  });

  assert(receivedFinalized !== null, 'sentence_finalized event should have fired');
  assert.strictEqual(receivedFinalized.translatedText, 'with hardship comes ease.');
  console.log('  ✔ Sentence finalized event emitted correctly.');

  // Test 6: Word-by-Word Streaming Simulation
  console.log('\n[Test 6] Testing Soniox word-by-word streaming simulation...');
  const simTokens = [];
  const onToken = (tok) => { simTokens.push(tok); };
  sonioxService.on('token_stream', onToken);

  sonioxService.startStreamingSimulation('test-session', ['en', 'ur'], 50);
  assert.strictEqual(sonioxService.isSimulating, true, 'Simulation should be marked active');

  // Wait 220ms to collect streaming tokens
  await new Promise(r => setTimeout(r, 220));
  sonioxService.stopStreamingSimulation();
  sonioxService.off('token_stream', onToken);

  assert(simTokens.length >= 2, `Should have emitted at least 2 streaming tokens (got ${simTokens.length})`);
  assert(simTokens.some(t => t.lang === 'en'), 'English tokens emitted');
  assert(simTokens.some(t => t.lang === 'ur'), 'Urdu tokens emitted');
  console.log(`  ✔ Successfully streamed ${simTokens.length} real-time tokens across ['en', 'ur'] at 50ms interval.`);

  console.log('\n========================================================');
  console.log('🎉 ALL SONIOX DYNAMIC GATE TESTS PASSED! (100% GREEN)');
  console.log('========================================================\n');
}

runSonioxGateTests().catch(err => {
  console.error('❌ Soniox Test Failure:', err);
  process.exit(1);
});
