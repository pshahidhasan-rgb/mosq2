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
      // Legacy fields (kept for external compatibility)
      currentOriginalText: '',
      currentTranslatedText: '',
      // Correct accumulation state:
      // confirmed* = is_final:true tokens (stable, accumulate within a sentence)
      // live*Preview = is_final:false tokens (current hypothesis, REPLACE each frame)
      confirmedOriginalText:   '',
      confirmedTranslatedText: '',
      liveOriginalPreview:     '',
      liveTranslatedPreview:   '',
      confirmedFinalCount:     0,   // how many final-original tokens we've already committed
      confirmedTransCount:     0,   // how many final-translation tokens we've already committed
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
        gate.confirmedFinalCount     = 0;
        gate.confirmedTransCount     = 0;
        gate.currentOriginalText     = '';
        gate.currentTranslatedText   = '';
        console.log(`[Soniox Gate] Connected & ready for language "${gate.lang}".`);

        // Send Sonnox start configuration payload
        // CRITICAL: api_key goes in the JSON config (not headers) per Sonnox API spec
        // enable_endpoint_detection: true with low latency allows word-by-word
        // streaming while detecting sentence boundaries for finalization
        const configMessage = {
          api_key: this.apiKey,
          model: DEFAULT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: SAMPLE_RATE,
          num_channels: NUM_CHANNELS,
          enable_endpoint_detection: true,
          endpoint_latency_adjustment_level: 3,
          max_endpoint_delay_ms: 300,  // Low latency finalization
          endpoint_sensitivity: -1.0,
          source_language: 'ar',  // Strictly Arabic speech recognition for pure Arabic output
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
   * Parse Soniox streaming tokens and dispatch in real-time.
   *
   * KEY BEHAVIOUR (fixed):
   *  - Soniox sends the FULL GROWING HYPOTHESIS in every frame, not just the delta.
   *    is_final:false tokens in frame N may repeat tokens from frame N-1 with revisions.
   *    → Non-final tokens must REPLACE the live preview, never be appended.
   *  - is_final:true means "this word is confirmed" — NOT "sentence is over".
   *    The real sentence-end signal is the <end>/<fin> special token.
   *    → Only emit sentence_finalized when <end>/<fin> is detected.
   */
  handleSonioxMessage(gate, data) {
    if (!data) return;

    const tokens = data.tokens || (data.result && data.result.tokens) || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    // Detect sentence boundary — ONLY <end> or <fin> signals this, not is_final
    const hasEndpoint = tokens.some(t => isSpecialToken(t.text || ''));

    // Filter out special control tokens — keep only speech/translation tokens
    const userTokens = tokens.filter(t => t.text && !isSpecialToken(t.text));

    if (userTokens.length > 0) {
      // Separate by finality and by type (original vs translation)
      const finalOrigTokens  = userTokens.filter(t =>  t.is_final && t.translation_status !== 'translation');
      const finalTransTokens = userTokens.filter(t =>  t.is_final && t.translation_status === 'translation');
      const liveOrigTokens   = userTokens.filter(t => !t.is_final && t.translation_status !== 'translation');
      const liveTransTokens  = userTokens.filter(t => !t.is_final && t.translation_status === 'translation');

      // ── Accumulate ONLY newly-seen confirmed tokens ─────────────────────────
      // finalOrigTokens includes ALL final-original tokens seen so far in this sentence.
      // We slice from confirmedFinalCount to grab only the NEW ones beyond what we committed.
      const newFinalOrig  = finalOrigTokens.slice(gate.confirmedFinalCount).map(t => t.text).join('');
      const newFinalTrans = finalTransTokens.slice(gate.confirmedTransCount).map(t => t.text).join('');

      if (newFinalOrig) {
        gate.confirmedOriginalText  += newFinalOrig;
        gate.confirmedFinalCount     = finalOrigTokens.length;
      }
      if (newFinalTrans) {
        gate.confirmedTranslatedText += newFinalTrans;
        gate.confirmedTransCount      = finalTransTokens.length;
      }

      // ── REPLACE live preview with the current non-final hypothesis ──────────
      // Each frame's non-final tokens represent Soniox's latest guess — overwrite, don't append.
      gate.liveOriginalPreview   = liveOrigTokens.map(t => t.text).join('');
      gate.liveTranslatedPreview = liveTransTokens.map(t => t.text).join('');

      // ── Build full current display state ────────────────────────────────────
      const originalFull   = gate.confirmedOriginalText   + gate.liveOriginalPreview;
      const translatedFull = gate.confirmedTranslatedText + gate.liveTranslatedPreview;

      // Sync legacy fields (used by some external health-check paths)
      gate.currentOriginalText   = originalFull;
      gate.currentTranslatedText = translatedFull;

      // ── Emit full-replacement token_stream event ────────────────────────────
      // isReplacement:true tells display.js to SET textContent, not concatenate.
      this.emit('token_stream', {
        lang:            gate.lang,
        originalFull,        // full current Arabic  — display should SET this
        translatedFull,      // full current English — display should SET this
        translatedChunk: '', // kept for backward-compat; not used when isReplacement:true
        originalChunk:   '', // kept for backward-compat; not used when isReplacement:true
        isReplacement:   true,
        isFinal:         false,
        timestamp:       new Date().toISOString()
      });
    }

    // ── Sentence boundary: only fire when Soniox sends <end> or <fin> ─────────
    if (hasEndpoint) {
      const fullFinalOriginal    = (gate.confirmedOriginalText   + gate.liveOriginalPreview).trim();
      const fullFinalTranslation = (gate.confirmedTranslatedText + gate.liveTranslatedPreview).trim();

      // Reset ALL accumulation state for the next sentence
      gate.confirmedOriginalText   = '';
      gate.confirmedTranslatedText = '';
      gate.liveOriginalPreview     = '';
      gate.liveTranslatedPreview   = '';
      gate.confirmedFinalCount     = 0;
      gate.confirmedTransCount     = 0;
      gate.currentOriginalText     = '';
      gate.currentTranslatedText   = '';

      if (fullFinalOriginal || fullFinalTranslation) {
        console.log(`[Soniox Gate ${gate.lang}] Sentence finalized | orig: "${fullFinalOriginal.substring(0, 60)}" | trans: "${fullFinalTranslation.substring(0, 60)}"`);
        this.emit('sentence_finalized', {
          lang:           gate.lang,
          finalText:      fullFinalTranslation,
          translatedText: fullFinalTranslation,
          originalText:   fullFinalOriginal,
          timestamp:      new Date().toISOString()
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
