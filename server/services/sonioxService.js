/**
 * Soniox Real-Time Speech Translation Service
 * 
 * Implements the "Dynamic Language Gates" Audio Fan-Out Architecture:
 *  - 1 Single Audio Ingest from Imam pulpit mic over mosque Wi-Fi
 *  - Dynamic On-Demand Gates: opens 1 Soniox WebSocket stream per active language
 *  - Audio Fan-Out: duplicates PCM audio in server memory and pipes to active gates
 *  - Auto-Detects source speech (Arabic, English, dialects) by omitting source_language
 *  - Sub-200ms end-to-end token streaming to TV and mobile attendees
 *  - Auto-closes gates when attendees leave ($0 for unused languages)
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const SONIOX_WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const DEFAULT_MODEL = 'stt-rt-v5';
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

function isSpecialToken(text) {
  if (!text) return true;
  const t = text.trim();
  return t === '<end>' || t === '<fin>' || /^<.*>$/.test(t);
}

class SonioxGateManager extends EventEmitter {
  constructor(apiKey = process.env.SONIOX_API_KEY) {
    super();
    this.apiKey = (apiKey || '').trim();
    this.activeGates = new Map(); // langCode -> GateConnection
    this.desiredLanguages = new Set(['en']);
    this._isStreamingAudio = false;
    this.isOperational = this.validateApiKey(this.apiKey);

    if (this.isOperational) {
      console.log('[Soniox] Dynamic Language Gates initialized with active API key.');
    } else {
      console.log('[Soniox] No valid SONIOX_API_KEY provided. Running in fallback mode.');
    }
  }

  validateApiKey(key) {
    if (!key || key.length < 20) return false;
    // Reject obvious placeholders
    if (key.includes('your_') || key.includes('placeholder')) return false;
    // Accept Sonnox project keys (snx_proj_...), legacy keys (sk-),
    // or any other key format (validation is done by Sonnox server itself)
    return true;
  }

  isConfigured() {
    return this.isOperational;
  }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
    this.isOperational = this.validateApiKey(this.apiKey);
  }

  /**
   * Synchronize active language gates with the currently required languages.
   * @param {Array<string>|Set<string>} requiredLanguages - List of active language codes
   */
  /**
   * Synchronize active language gates with the currently required languages.
   * NOTE: Only opens/maintains live WebSockets when audio is actively streaming.
   * If mic is idle/off, this merely records the desired languages without opening connections.
   * @param {Array<string>|Set<string>} requiredLanguages - List of active language codes
   * @param {object} options - { force: boolean } to force gate opening (for unit testing)
   */
  syncGates(requiredLanguages, { force = false } = {}) {
    if (!this.isOperational) return;

    const reqSet = new Set(Array.from(requiredLanguages || []).filter(l => l && typeof l === 'string'));
    if (reqSet.size === 0) reqSet.add('en');
    this.desiredLanguages = reqSet;

    // CRITICAL COST SAFEGUARD:
    // Only open/maintain live Soniox WebSockets if microphone audio is actively flowing right now
    // (or explicitly forced by tests). If mic is idle/off, NEVER open connections ($0 cost).
    if (this._isStreamingAudio || force) {
      // 1. Open new gates for newly requested languages
      for (const lang of reqSet) {
        this.ensureGate(lang);
      }

      // 2. Close gates for languages that are no longer requested
      for (const [lang, gate] of this.activeGates.entries()) {
        if (!reqSet.has(lang)) {
          console.log(`[Soniox Gate] 0 listeners remaining for "${lang}" — closing gate ($0 cost).`);
          this.closeGate(lang);
        }
      }
    } else {
      // If mic is idle, ensure no background connections remain open
      if (this.activeGates.size > 0) {
        this.closeAllGates();
      }
    }
  }

  /**
   * Ensures a dedicated Soniox WebSocket stream exists for a specific target language.
   * @param {string} langCode - Target language (e.g., 'en', 'bn', 'ur', 'zh')
   */
  ensureGate(langCode) {
    if (!this.isOperational || !langCode) return null;

    const existing = this.activeGates.get(langCode);
    if (existing && (existing.status === 'open' || existing.status === 'connecting')) {
      return existing;
    }

    console.log(`[Soniox Gate] Opening dynamic gate for target language: "${langCode}" ($0.18/hr)...`);

    const gate = {
      lang: langCode,
      ws: null,
      status: 'connecting',
      audioQueue: [],
      // Legacy fields (kept for external compatibility)
      currentOriginalText: '',
      currentTranslatedText: '',
      // Correct accumulation state:
      // Correct accumulation state:
      // confirmed* = is_final:true tokens (sent once by Soniox, accumulate permanently for the sentence)
      // live*Preview = is_final:false tokens (provisional hypothesis tail, REPLACE each frame)
      confirmedOriginalText:   '',
      confirmedTranslatedText: '',
      liveOriginalPreview:     '',
      liveTranslatedPreview:   '',
      reconnectAttempts: 0,
      createdAt: Date.now()
    };

    this.activeGates.set(langCode, gate);
    this.connectGate(gate);
    return gate;
  }

  connectGate(gate) {
    if (!this.isOperational) return;

    try {
      const ws = new WebSocket(SONIOX_WS_ENDPOINT);

      ws.apiKey = this.apiKey;

      gate.ws = ws;

      ws.on('open', () => {
        gate.status = 'open';
        gate.reconnectAttempts = 0;
        // Reset all accumulation state on (re)connect so stale data never leaks
        gate.confirmedOriginalText   = '';
        gate.confirmedTranslatedText = '';
        gate.liveOriginalPreview     = '';
        gate.liveTranslatedPreview   = '';
        gate.currentOriginalText     = '';
        gate.currentTranslatedText   = '';
        console.log(`[Soniox Gate] Connected & ready for language "${gate.lang}".`);

        // Send Soniox start configuration payload
        // CRITICAL: api_key goes in the JSON config (not headers) per Soniox API spec
        // enable_endpoint_detection: true with balanced latency allows word-by-word
        // streaming while detecting natural sentence boundaries for finalization
        const configMessage = {
          api_key: this.apiKey,
          model: DEFAULT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: SAMPLE_RATE,
          num_channels: NUM_CHANNELS,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: 600,
          enable_language_identification: true,
          translation: {
            type: 'one_way',
            target_language: gate.lang
          }
        };

        ws.send(JSON.stringify(configMessage));

        // Flush any buffered audio chunks
        if (gate.audioQueue.length > 0) {
          while (gate.audioQueue.length > 0) {
            const chunk = gate.audioQueue.shift();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
          }
        }
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this.handleSonioxMessage(gate, data);
        } catch (err) {
          console.warn(`[Soniox Gate ${gate.lang}] Message parse error:`, err.message);
        }
      });

      ws.on('error', (err) => {
        console.warn(`[Soniox Gate ${gate.lang}] WS Error:`, err.message);
        gate.status = 'error';
      });

      ws.on('close', (code, reason) => {
        console.log(`[Soniox Gate ${gate.lang}] WS Closed (${code}): ${reason || 'Normal'}`);
        gate.status = 'closed';

        // Auto-reconnect ONLY if we are ACTIVELY streaming audio right now
        if (this._isStreamingAudio && this.activeGates.has(gate.lang) && gate.reconnectAttempts < 5) {
          gate.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, gate.reconnectAttempts), 10000);
          setTimeout(() => {
            if (this._isStreamingAudio && this.activeGates.has(gate.lang)) {
              this.connectGate(gate);
            }
          }, delay);
        }
      });

    } catch (err) {
      console.error(`[Soniox Gate ${gate.lang}] Connection exception:`, err.message);
      gate.status = 'error';
    }
  }

  /**
   * Parse Soniox streaming tokens and dispatch in real-time.
   *
   * Append-and-Replace architecture (per official Soniox specification):
   *  1. Confirmed tokens (is_final:true): sent once by Soniox. We append each
   *     newly confirmed token directly to confirmedOriginalText / confirmedTranslatedText.
   *  2. Provisional tokens (is_final:false): Soniox's live hypothesis for the current
   *     words/phrase. Each frame's provisional tokens REPLACE liveOriginalPreview /
   *     liveTranslatedPreview.
   *  3. Independent streams: Transcription (original) and Translation tokens arrive
   *     independently. Both are tracked cleanly in currentUtt accumulation state.
   *  4. Full replacement display: The UI always receives (confirmed + livePreview) and
   *     SETs the text, giving sub-200ms real-time fluidity with zero duplicates.
   *  5. Sentence boundary: <end>/<fin> triggers finalization and resets the buffer.
   */
  handleSonioxMessage(gate, data) {
    if (!data) return;

    if (data.error_code || data.error_message || data.error) {
      console.error(`[Soniox Gate ${gate.lang}] Soniox API Error:`, data.error_code, data.error_message || data.error);
      if (data.error_code === 402 || data.error_type === 'organization_balance_exhausted') {
        console.error('[Soniox] Balance exhausted. Disabling Soniox gates and closing connections to prevent loops.');
        this.isOperational = false;
        this.closeAllGates();
      }
      return;
    }

    const tokens = data.tokens || (data.result && data.result.tokens) || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    let hasEndpoint = false;

    // Reset provisional preview tail on every frame (provisional tokens represent
    // the current in-flight hypothesis tail sent by Soniox in this frame)
    gate.liveOriginalPreview = '';
    gate.liveTranslatedPreview = '';

    for (const t of tokens) {
      if (!t.text) continue;

      if (isSpecialToken(t.text)) {
        hasEndpoint = true;
        continue;
      }

      const isTranslation = t.translation_status === 'translation';
      if (isTranslation) {
        if (t.is_final) {
          gate.confirmedTranslatedText += t.text;
        } else {
          gate.liveTranslatedPreview += t.text;
        }
      } else {
        if (t.is_final) {
          gate.confirmedOriginalText += t.text;
        } else {
          gate.liveOriginalPreview += t.text;
        }
      }
    }

    // Build full current display state
    const originalFull = gate.confirmedOriginalText + gate.liveOriginalPreview;
    const translatedFull = gate.confirmedTranslatedText + gate.liveTranslatedPreview;

    // Sync legacy fields
    gate.currentOriginalText = originalFull;
    gate.currentTranslatedText = translatedFull;

    // Emit live streaming tokens (sub-200ms word-by-word)
    if (originalFull.length > 0 || translatedFull.length > 0) {
      // Live streaming log: shows speech being processed in real-time
      this._tokenEmitCount = (this._tokenEmitCount || 0) + 1;
      if (this._tokenEmitCount % 6 === 1) {
        console.log(`[Soniox Stream ${gate.lang}] Live words | orig: "${originalFull.slice(-40)}" | trans: "${translatedFull.slice(-40)}"`);
      }

      this.emit('token_stream', {
        lang: gate.lang,
        originalFinal: gate.confirmedOriginalText,
        originalPartial: gate.liveOriginalPreview,
        translatedFinal: gate.confirmedTranslatedText,
        translatedPartial: gate.liveTranslatedPreview,
        originalFull,
        translatedFull,
        translatedChunk: '',
        originalChunk: '',
        isReplacement: true,
        isFinal: false,
        timestamp: new Date().toISOString()
      });
    }

    // Sentence boundary handling (<end> or <fin>)
    if (hasEndpoint) {
      const fullFinalOriginal = (gate.confirmedOriginalText + gate.liveOriginalPreview).trim();
      const fullFinalTranslation = (gate.confirmedTranslatedText + gate.liveTranslatedPreview).trim();

      if (fullFinalOriginal || fullFinalTranslation) {
        this.emit('token_stream', {
          lang: gate.lang,
          originalFinal: fullFinalOriginal,
          originalPartial: '',
          translatedFinal: fullFinalTranslation,
          translatedPartial: '',
          originalFull: fullFinalOriginal,
          translatedFull: fullFinalTranslation,
          translatedChunk: '',
          originalChunk: '',
          isReplacement: true,
          isFinal: true,
          timestamp: new Date().toISOString()
        });

        console.log(`[Soniox Finalized ${gate.lang}] Utterance complete | orig: "${fullFinalOriginal}" | trans: "${fullFinalTranslation}"`);
        this.emit('sentence_finalized', {
          lang: gate.lang,
          finalText: fullFinalTranslation,
          translatedText: fullFinalTranslation,
          originalText: fullFinalOriginal,
          timestamp: new Date().toISOString()
        });
      }

      // Reset accumulation state for the next sentence
      gate.confirmedOriginalText = '';
      gate.confirmedTranslatedText = '';
      gate.liveOriginalPreview = '';
      gate.liveTranslatedPreview = '';
      gate.currentOriginalText = '';
      gate.currentTranslatedText = '';
    }
  }

  /**
   * Broadcast audio buffer to all open language gates (Audio Fan-Out)
   * @param {Buffer} pcmBuffer - 16kHz, 16-bit mono PCM audio
   */
  broadcastAudio(pcmBuffer) {
    if (!this.isOperational || !pcmBuffer || !Buffer.isBuffer(pcmBuffer)) return;

    // Safety 1: Strictly reject accidental text/JSON buffers (JSON starts with '{' [0x7B] or '[' [0x5B])
    if (pcmBuffer.length > 2 && (pcmBuffer[0] === 0x7B || pcmBuffer[0] === 0x5B)) {
      console.warn('[Soniox Audio] Rejected text JSON buffer passed to broadcastAudio.');
      return;
    }

    // Safety 2: 16-bit PCM MUST be a multiple of 2 bytes
    if (pcmBuffer.length % 2 !== 0) {
      pcmBuffer = pcmBuffer.subarray(0, pcmBuffer.length - (pcmBuffer.length % 2));
    }
    if (pcmBuffer.length < 2) return;

    // Periodic audio stream log (every 50 chunks = ~2-3 seconds of live mic)
    this._audioChunkCount = (this._audioChunkCount || 0) + 1;
    if (this._audioChunkCount % 50 === 1) {
      console.log(`[Soniox Audio Ingest] Live mic audio stream active (${pcmBuffer.length} bytes/chunk, gates: ${Array.from(this.activeGates.keys()).join(', ') || 'en'})`);
    }

    this._isStreamingAudio = true;

    // Inactivity watchdog: Auto-close all gates if no audio is received for 10 seconds.
    // This strictly prevents credit drain when server runs 24/7 on Railway without active speech.
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      this._isStreamingAudio = false;
      if (this.activeGates.size > 0) {
        console.log('[Soniox] Inactivity timeout: 10s with no microphone audio. Auto-closing all gates to preserve credits ($0 cost).');
        this.closeAllGates();
      }
    }, 10000);

    // Open gates on-demand for desired languages (defaults to 'en') ONLY when audio is actively flowing
    const targetLangs = (this.desiredLanguages && this.desiredLanguages.size > 0)
      ? Array.from(this.desiredLanguages)
      : ['en'];

    for (const lang of targetLangs) {
      if (!this.activeGates.has(lang)) {
        this.ensureGate(lang);
      }
    }

    for (const [lang, gate] of this.activeGates.entries()) {
      if (gate.status === 'open' && gate.ws && gate.ws.readyState === WebSocket.OPEN) {
        try {
          gate.ws.send(pcmBuffer);
        } catch (e) {
          console.warn(`[Soniox Gate ${lang}] Send error:`, e.message);
        }
      } else if (gate.status === 'connecting') {
        // Buffer up to 100 chunks while establishing handshake
        if (gate.audioQueue.length < 100) {
          gate.audioQueue.push(pcmBuffer);
        }
      }
    }
  }

  /**
   * Close a specific language gate
   * @param {string} langCode
   */
  closeGate(langCode) {
    const gate = this.activeGates.get(langCode);
    if (!gate) return;

    this.activeGates.delete(langCode);
    gate.reconnectAttempts = 999; // Prevent any scheduled reconnect
    if (gate.ws) {
      try {
        gate.ws.removeAllListeners();
        gate.ws.close(1000, 'Gate closed by manager');
      } catch (_) {}
    }
    gate.status = 'closed';
  }

  /**
   * Close all active gates (e.g. when session ends or audio is inactive)
   */
  closeAllGates() {
    this._isStreamingAudio = false;
    if (this._inactivityTimer) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
    for (const lang of Array.from(this.activeGates.keys())) {
      this.closeGate(lang);
    }
    console.log('[Soniox] All gates closed. 0 active WebSocket connections ($0/hr cost).');
  }

  /**
   * Get current gate status for monitoring and health check
   */
  getStatus() {
    return {
      operational: this.isOperational,
      activeGateCount: this.activeGates.size,
      activeLanguages: Array.from(this.activeGates.keys()),
      estimatedHourlyCost: (this.activeGates.size * 0.18).toFixed(2) + ' USD/hr'
    };
  }
}

module.exports = new SonioxGateManager();
