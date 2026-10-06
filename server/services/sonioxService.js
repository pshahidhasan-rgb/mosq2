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
    return Boolean(key && key.length > 5 && !key.includes('your_') && !key.includes('placeholder'));
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
      const ws = new WebSocket(SONIOX_WS_ENDPOINT, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      gate.ws = ws;

      ws.on('open', () => {
        gate.status = 'open';
        gate.reconnectAttempts = 0;
        console.log(`[Soniox Gate] Connected & ready for language "${gate.lang}".`);

        // Send Soniox start configuration payload
        const configMessage = {
          model: DEFAULT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: SAMPLE_RATE,
          num_channels: NUM_CHANNELS,
          translation: {
            type: 'one_way',
            target_language: gate.lang
            // Note: source_language is omitted to allow auto-detection ("detect any")
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
   * Parse Soniox streaming tokens and dispatch
   */
  handleSonioxMessage(gate, data) {
    if (!data) return;

    // Check for tokens array
    const tokens = data.tokens || (data.result && data.result.tokens) || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    let hasTranslation = false;
    let hasOriginal = false;
    let translatedWords = [];
    let originalWords = [];
    let isFinal = false;

    for (const token of tokens) {
      const text = token.text || '';
      const status = token.translation_status || 'none';
      if (token.is_final) isFinal = true;

      if (status === 'translation') {
        hasTranslation = true;
        translatedWords.push(text);
      } else if (status === 'original' || status === 'none') {
        hasOriginal = true;
        originalWords.push(text);
      }
    }

    const translatedTextChunk = translatedWords.join('');
    const originalTextChunk = originalWords.join('');

    if (hasTranslation || hasOriginal) {
      this.emit('token_stream', {
        lang: gate.lang,
        translatedChunk: translatedTextChunk,
        originalChunk: originalTextChunk,
        isFinal: Boolean(isFinal),
        timestamp: new Date().toISOString()
      });
    }

    if (isFinal) {
      // Sentence finalized
      this.emit('sentence_finalized', {
        lang: gate.lang,
        translatedText: translatedTextChunk,
        originalText: originalTextChunk,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Broadcast audio buffer to all open language gates (Audio Fan-Out)
   * @param {Buffer} pcmBuffer - 16kHz, 16-bit mono PCM audio
   */
  broadcastAudio(pcmBuffer) {
    if (!this.isOperational || !pcmBuffer || !Buffer.isBuffer(pcmBuffer)) return;

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
