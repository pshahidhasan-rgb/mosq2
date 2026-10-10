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

class SonioxGateManager extends EventEmitter {
  constructor(apiKey = process.env.SONIOX_API_KEY) {
    super();
    this.apiKey = (apiKey || '').trim();
    this.activeGates = new Map(); // langCode -> GateConnection
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
  syncGates(requiredLanguages) {
    if (!this.isOperational) return;

    const reqSet = new Set(Array.from(requiredLanguages || []).filter(l => l && typeof l === 'string'));
    
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
      currentOriginalText: '',
      currentTranslatedText: '',
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
        console.log(`[Soniox Gate] Connected & ready for language "${gate.lang}".`);

        // Send Sonnox start configuration payload
        // CRITICAL: api_key goes in the JSON config (not headers) per Sonnox API spec
        // enable_endpoint_detection: true with high latency level allows word-by-word
        // streaming while still detecting sentence boundaries for finalization
        const configMessage = {
          api_key: this.apiKey,
          model: DEFAULT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: SAMPLE_RATE,
          num_channels: NUM_CHANNELS,
          enable_endpoint_detection: true,
          endpoint_latency_adjustment_level: 3,
          max_endpoint_delay_ms: 500,
          endpoint_sensitivity: -1.0,
          translation: {
            type: 'one_way',
            target_language: gate.lang
            // Note: source_language is omitted for auto-detection ("detect any")
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

        // Auto-reconnect if gate is still desired in active map
        if (this.activeGates.has(gate.lang) && gate.reconnectAttempts < 5) {
          gate.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, gate.reconnectAttempts), 10000);
          setTimeout(() => {
            if (this.activeGates.has(gate.lang)) {
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
   * Parse Soniox streaming tokens and dispatch immediately (per-token for sub-200ms latency)
   */
  handleSonioxMessage(gate, data) {
    if (!data) return;

    // Soniox returns tokens individually via data.tokens or data.result.tokens
    const tokens = data.tokens || (data.result && data.result.tokens) || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    // Emit each token IMMEDIATELY as it arrives — no batching
    for (const token of tokens) {
      const text = token.text || '';
      const status = token.translation_status || 'none';
      const isFinal = Boolean(token.is_final);

      if (status === 'translation') {
        gate.currentTranslatedText = (gate.currentTranslatedText || '') + text;
        // Word-by-word translation token — stream immediately
        this.emit('token_stream', {
          lang: gate.lang,
          translatedChunk: text,
          originalChunk: '',
          isFinal,
          token,
          timestamp: new Date().toISOString()
        });
      } else if (status === 'original' || status === 'none') {
        gate.currentOriginalText = (gate.currentOriginalText || '') + text;
        // Original (Arabic) word token — stream immediately
        this.emit('token_stream', {
          lang: gate.lang,
          translatedChunk: '',
          originalChunk: text,
          isFinal,
          token,
          timestamp: new Date().toISOString()
        });
      }

      // Sentence boundary — fire finalized event with full accumulated sentence
      if (isFinal) {
        const fullFinalTranslation = (gate.currentTranslatedText || text).trim();
        const fullFinalOriginal = (gate.currentOriginalText || (status === 'original' || status === 'none' ? text : '')).trim();
        gate.currentTranslatedText = '';
        gate.currentOriginalText = '';

        this.emit('sentence_finalized', {
          lang: gate.lang,
          finalText: fullFinalTranslation,
          translatedText: fullFinalTranslation,
          originalText: fullFinalOriginal,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Broadcast audio buffer to all open language gates (Audio Fan-Out)
   * @param {Buffer} pcmBuffer - 16kHz, 16-bit mono PCM audio
   */
  broadcastAudio(pcmBuffer) {
    if (!this.isOperational || !pcmBuffer || !Buffer.isBuffer(pcmBuffer)) return;

    // Ensure default English gate is open so initial sermon speech is never discarded
    if (this.activeGates.size === 0) {
      this.ensureGate('en');
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
    if (gate.ws) {
      try {
        gate.ws.close(1000, 'Gate closed by manager');
      } catch (_) {}
    }
    gate.status = 'closed';
  }

  /**
   * Close all active gates (e.g. when session ends)
   */
  closeAllGates() {
    for (const lang of Array.from(this.activeGates.keys())) {
      this.closeGate(lang);
    }
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
