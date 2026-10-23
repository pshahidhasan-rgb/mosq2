/**
 * Soniox Real-Time Speech Translation Service
 * 
 * Implements the "Dynamic Language Gates" Audio Fan-Out Architecture:
 *  - 1 Single Audio Ingest from Imam pulpit mic over mosque Wi-Fi (16kHz PCM mono)
 *  - Dynamic On-Demand Gates: opens 1 Soniox WebSocket stream per active language
 *  - Audio Fan-Out: duplicates PCM audio in server memory and pipes to active gates
 *  - Append-and-Replace Live Streaming:
 *      * Finalized tokens (is_final: true) are appended permanently to stable text.
 *      * Provisional tokens (is_final: false) replace the live tail every frame.
 *      * Continuous sentence commits on punctuation (. ! ? ؟ ۔) without waiting for pauses.
 *      * Monotonic sequence (seq) numbering for rock-solid ordering and deduplication.
 *  - Zero Data Loss on Reconnect: commits pending text on disconnect and buffers up to
 *    15s of audio frames during socket reconnects.
 *  - Keepalive pings every 5s prevent idle stream timeouts during Khutbah pauses.
 *  - Auto-closes gates on inactivity ($0 cost for unused languages).
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const SONIOX_WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const DEFAULT_MODEL = process.env.SONIOX_MODEL || 'stt-rt-v5';
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

const PARTIAL_THROTTLE_MS = 60;
const KEEPALIVE_MS = 5000;
const MAX_QUEUE_BYTES = 16000 * 2 * 15; // 15 seconds of 16kHz 16-bit PCM (480,000 bytes)
const SENTENCE_END = /[.!?؟。！？۔]\s*/g; // Sentence punctuation (incl. Arabic ؟, Urdu ۔, Chinese 。！？)
const MAX_SEGMENT_CHARS = 220; // Force commit during long continuous speech without punctuation

// Per-language glossaries (carefully phrased to prevent unwanted replacements)
const GLOSSARY = {
  en: [
    { source: 'صلاة', target: 'Salah' },
    { source: 'زكاة', target: 'Zakat' },
    { source: 'تقوى', target: 'Taqwa' },
    { source: 'الجنة', target: 'Jannah' },
    { source: 'جهنم', target: 'Jahannam' },
    { source: 'السنة النبوية', target: 'the Sunnah' },
    { source: 'صلى الله عليه وسلم', target: 'ﷺ' },
    { source: 'رضي الله عنه', target: '(may Allah be pleased with him)' },
    { source: 'عز وجل', target: '(the Mighty and Majestic)' },
    { source: 'سبحان الله', target: 'SubhanAllah' },
    { source: 'الحمد لله', target: 'Alhamdulillah' },
    { source: 'إن شاء الله', target: "In sha' Allah" },
    { source: 'الله أكبر', target: 'Allahu Akbar' },
    { source: 'خطبة', target: 'Khutbah' },
    { source: 'مسجد', target: 'Masjid' },
    { source: 'إمام', target: 'Imam' },
    { source: 'دعاء', target: "Du'a" },
    { source: 'حديث', target: 'Hadith' }
  ]
};

function isSpecialToken(text) {
  if (!text) return true;
  const t = text.trim();
  return t === '<end>' || t === '<fin>' || /^<.*>$/.test(t);
}

class SonioxGateManager extends EventEmitter {
  constructor(apiKey = process.env.SONIOX_API_KEY) {
    super();
    this.apiKey = (apiKey || '').trim();
    this.activeGates = new Map(); // langCode -> gate object
    this.gateRemovalTimers = new Map(); // langCode -> timer (debounce gate closing)
    this.isOperational = this.validateApiKey(this.apiKey);
    this._inactivityTimer = null;

    if (this.isOperational) {
      console.log('[Soniox] Dynamic Language Gates initialized with active API key.');
    } else {
      console.log('[Soniox] No valid SONIOX_API_KEY provided. Running in fallback mode.');
    }
  }

  validateApiKey(key) {
    if (!key || key.length < 20) return false;
    if (key.includes('your_') || key.includes('placeholder')) return false;
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
   * Build clean, documented Soniox real-time config payload.
   * Removes unsupported fields (endpoint_latency_adjustment_level, source_language)
   * and uses language_hints: ['ar'] per Soniox RT API spec.
   */
  buildConfig(lang) {
    return {
      api_key: this.apiKey,
      model: DEFAULT_MODEL,
      audio_format: 'pcm_s16le',
      sample_rate: SAMPLE_RATE,
      num_channels: NUM_CHANNELS,
      language_hints: ['ar'],
      enable_endpoint_detection: true, // Used as commit hint, never as display gate
      context: {
        general: [
          { key: 'domain', value: 'Islamic sermon (Khutbah)' },
          { key: 'setting', value: 'Friday prayer in a mosque' }
        ],
        terms: ['خطبة', 'الجمعة', 'التقوى', 'رسول الله'],
        translation_terms: GLOSSARY[lang] || []
      },
      translation: {
        type: 'one_way',
        target_language: lang
      }
    };
  }

  /**
   * Synchronize active language gates with the currently required languages.
   * Debounces gate closure by 10s to prevent thrashing when attendees reload/switch.
   * @param {Array<string>|Set<string>} requiredLanguages - List of active language codes
   */
  syncGates(requiredLanguages) {
    if (!this.isOperational) return;

    const reqSet = new Set(Array.from(requiredLanguages || []).filter(l => l && typeof l === 'string'));

    // 1. Open newly requested gates and cancel pending close timers
    for (const lang of reqSet) {
      if (this.gateRemovalTimers.has(lang)) {
        clearTimeout(this.gateRemovalTimers.get(lang));
        this.gateRemovalTimers.delete(lang);
      }
      this.ensureGate(lang);
    }

    // 2. Debounce closure for languages that have 0 listeners
    for (const [lang, gate] of this.activeGates.entries()) {
      if (!reqSet.has(lang) && !this.gateRemovalTimers.has(lang)) {
        const timer = setTimeout(() => {
          this.gateRemovalTimers.delete(lang);
          console.log(`[Soniox Gate] 0 listeners remaining for "${lang}" — closing gate ($0 cost).`);
          this.closeGate(lang);
        }, 10000); // 10-second debounce
        this.gateRemovalTimers.set(lang, timer);
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

    console.log(`[Soniox Gate] Opening dynamic gate for target language: "${langCode}"...`);

    const gate = {
      lang: langCode,
      ws: null,
      status: 'connecting',
      closing: false,
      audioQueue: [],
      queuedBytes: 0,
      lastAudioAt: Date.now(),
      // Translation buffers:
      stableTr: '', // Finalized tokens (appended permanently until sentence commit)
      liveTr: '',   // Provisional token hypothesis (replaced every frame)
      // Original Arabic speech buffers:
      stableOr: '',
      liveOr: '',
      // Legacy compatibility:
      currentOriginalText: '',
      currentTranslatedText: '',
      seq: 0,
      emitTimer: null,
      keepaliveTimer: null,
      reconnectAttempts: 0,
      createdAt: Date.now()
    };

    this.activeGates.set(langCode, gate);
    this.connectGate(gate);
    return gate;
  }

  connectGate(gate) {
    if (!this.isOperational || gate.closing) return;

    try {
      const ws = new WebSocket(SONIOX_WS_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        },
        perMessageDeflate: false
      });
      gate.ws = ws;
      gate.status = 'connecting';

      ws.on('open', () => {
        gate.status = 'open';
        gate.reconnectAttempts = 0;
        console.log(`[Soniox Gate] Connected & ready for language "${gate.lang}".`);

        // Send start configuration payload
        ws.send(JSON.stringify(this.buildConfig(gate.lang)));

        // Flush any audio captured while socket was connecting/reconnecting -> zero lost speech
        if (gate.audioQueue.length > 0) {
          console.log(`[Soniox Gate ${gate.lang}] Flushing ${gate.audioQueue.length} buffered audio chunks (${gate.queuedBytes} bytes)...`);
          for (const chunk of gate.audioQueue) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk, { binary: true });
            }
          }
          gate.audioQueue = [];
          gate.queuedBytes = 0;
        }

        // Keepalive timer: ping every 5s if silence > 5s to prevent Soniox idle timeout
        clearInterval(gate.keepaliveTimer);
        gate.keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && Date.now() - gate.lastAudioAt > KEEPALIVE_MS) {
            try {
              ws.send(JSON.stringify({ type: 'keepalive' }));
            } catch (_) {}
          }
        }, KEEPALIVE_MS);
      });

      ws.on('message', (raw) => {
        this.onSonioxMessage(gate, raw);
      });

      ws.on('error', (err) => {
        console.warn(`[Soniox Gate ${gate.lang}] WS Error:`, err.message);
      });

      ws.on('close', (code, reason) => {
        clearInterval(gate.keepaliveTimer);

        // Never lose finalized words: commit everything we currently have
        this.commit(gate, 'socket-close', /* includeLive */ true);

        if (gate.closing || !this.isOperational) {
          gate.status = 'closed';
          return;
        }

        gate.status = 'reconnecting';
        const delay = Math.min(250 * Math.pow(2, gate.reconnectAttempts++), 5000);
        console.warn(`[Soniox Gate ${gate.lang}] WS Closed (${code}: ${reason || 'Blip'}); auto-reconnect in ${delay}ms...`);

        setTimeout(() => {
          if (!gate.closing && this.isOperational && this.activeGates.has(gate.lang)) {
            this.connectGate(gate);
          }
        }, delay);
      });

    } catch (err) {
      console.error(`[Soniox Gate ${gate.lang}] Connection exception:`, err.message);
      gate.status = 'error';
    }
  }

  /**
   * Parse Soniox streaming tokens and dispatch in real time.
   *
   * Append-and-Replace Architecture:
   *  1. Confirmed tokens (is_final: true): Soniox emits these once; we append them to stableTr / stableOr.
   *  2. Provisional tokens (is_final: false): Live hypothesis; replaces liveTr / liveOr every frame.
   *  3. Continuous Commits: Sentence boundaries (. ! ? ؟ ۔) in stable text trigger commits
   *     immediately during continuous speech without waiting for pauses!
   *  4. Endpoints: <end> or <fin> trigger a clean flush for pause boundaries.
   */
  onSonioxMessage(gate, raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.error_code || data.error_message || data.error) {
      console.error(`[Soniox Gate ${gate.lang}] API Error:`, data.error_code, data.error_message || data.error);
      if (data.error_code === 401 || data.error_type === 'unauthenticated') {
        console.error('[Soniox] Authentication error (401 Incorrect API Key). Please verify SONIOX_API_KEY in .env.');
        this.isOperational = false;
        this.closeAllGates();
        return;
      }
      if (data.error_code === 402 || data.error_type === 'organization_balance_exhausted') {
        console.error('[Soniox] Balance exhausted. Disabling Soniox gates.');
        this.isOperational = false;
        this.closeAllGates();
        return;
      }
      // Non-fatal API error: close socket to trigger clean reconnect
      try { gate.ws.close(); } catch (_) {}
      return;
    }

    const tokens = data.tokens || (data.result && data.result.tokens) || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    let liveTr = '';
    let liveOr = '';
    let endpoint = false;

    for (const t of tokens) {
      if (!t.text) continue;
      if (t.text === '<end>' || t.text === '<fin>') {
        endpoint = true;
        continue;
      }
      if (isSpecialToken(t.text)) continue;

      const isTr = t.translation_status === 'translation';
      if (t.is_final) {
        // FINAL: append permanently once
        if (isTr) gate.stableTr += t.text;
        else gate.stableOr += t.text;
      } else {
        // NON-FINAL: provisional tail, replaced every message
        if (isTr) liveTr += t.text;
        else liveOr += t.text;
      }
    }

    gate.liveTr = liveTr;
    gate.liveOr = liveOr;

    if (endpoint) {
      this.commit(gate, 'endpoint', /* includeLive */ false);
    } else {
      this.commitCompletedSentences(gate);
    }

    // Schedule partial streaming token update (throttled to ~60ms)
    this.schedulePartial(gate);

    if (data.finished) {
      try { gate.ws.close(); } catch (_) {}
    }
  }

  // Alias for backward compatibility
  handleSonioxMessage(gate, data) {
    this.onSonioxMessage(gate, Buffer.from(JSON.stringify(data)));
  }

  /**
   * Commit full sentences as soon as they are finalized, without waiting for the speaker to pause.
   * This is what enables continuous khutbah speech to flow seamlessly onto the screen!
   */
  commitCompletedSentences(gate) {
    const s = gate.stableTr;
    if (!s || s.length === 0) return;

    let cut = -1;
    let m;
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(s)) !== null) {
      cut = m.index + m[0].length;
    }

    if (cut > 0) {
      const sentenceToCommit = s.slice(0, cut);
      const arabicToCommit = this.takeArabicPrefix(gate);
      gate.stableTr = s.slice(cut);
      this.emitCommit(gate, sentenceToCommit, arabicToCommit, 'sentence-punctuation');
    } else if (s.length > MAX_SEGMENT_CHARS) {
      // Endless run-on speech without punctuation: cut at nearest word boundary
      const sp = s.lastIndexOf(' ', MAX_SEGMENT_CHARS);
      const at = sp > 40 ? sp + 1 : s.length;
      const segmentToCommit = s.slice(0, at);
      const arabicToCommit = this.takeArabicPrefix(gate);
      gate.stableTr = s.slice(at);
      this.emitCommit(gate, segmentToCommit, arabicToCommit, 'length-cap');
    }
  }

  takeArabicPrefix(gate) {
    const ar = gate.stableOr;
    gate.stableOr = '';
    return ar;
  }

  /**
   * Commit the current buffer (called on endpoint, socket close, or manual flush).
   */
  commit(gate, reason = 'endpoint', includeLive = false) {
    const tr = (gate.stableTr + (includeLive ? gate.liveTr : '')).trim();
    const ar = (gate.stableOr + (includeLive ? gate.liveOr : '')).trim();
    gate.stableTr = '';
    gate.stableOr = '';
    if (includeLive) {
      gate.liveTr = '';
      gate.liveOr = '';
    }
    if (tr || ar) {
      this.emitCommit(gate, tr, ar, reason);
    }
  }

  /**
   * Emit commit events across both modern and legacy channels.
   */
  emitCommit(gate, translated, arabic, reason = 'sentence') {
    translated = (translated || '').trim();
    arabic = (arabic || '').trim();
    if (!translated && !arabic) return;

    const seq = ++gate.seq;
    const ts = new Date().toISOString();

    // 1. Emit token_stream with isFinal: true so TV display locks in the completed sentence immediately
    this.emit('token_stream', {
      lang: gate.lang,
      originalFull: arabic,
      translatedFull: translated,
      originalChunk: '',
      translatedChunk: '',
      isReplacement: true,
      isFinal: true,
      seq,
      timestamp: ts
    });

    // 2. Emit sentence_finalized for history storage and admin transcript
    this.emit('sentence_finalized', {
      lang: gate.lang,
      seq,
      finalText: translated,
      translatedText: translated,
      originalText: arabic,
      reason,
      timestamp: ts
    });

    // 3. Emit modern commit event
    this.emit('commit', {
      lang: gate.lang,
      seq,
      translated,
      arabic,
      reason,
      t: Date.now()
    });
  }

  /**
   * Schedule throttled partial token updates to clients (~60ms / ~16fps max).
   * Gives instant, buttery-smooth word-by-word streaming without overloading sockets.
   */
  schedulePartial(gate) {
    if (gate.emitTimer) return;

    gate.emitTimer = setTimeout(() => {
      gate.emitTimer = null;

      const originalFull = (gate.stableOr + gate.liveOr).trimStart();
      const translatedFull = (gate.stableTr + gate.liveTr).trimStart();

      gate.currentOriginalText = originalFull;
      gate.currentTranslatedText = translatedFull;

      const ts = new Date().toISOString();

      // Emit full-replacement token_stream for display.js and join.js
      this.emit('token_stream', {
        lang: gate.lang,
        originalFull,
        translatedFull,
        originalChunk: '',
        translatedChunk: '',
        isReplacement: true,
        isFinal: false,
        seq: gate.seq + 1,
        timestamp: ts
      });

      // Emit modern partial event
      this.emit('partial', {
        lang: gate.lang,
        seq: gate.seq + 1,
        stable: gate.stableTr,
        live: gate.liveTr,
        arabicStable: gate.stableOr,
        arabicLive: gate.liveOr,
        t: Date.now()
      });
    }, PARTIAL_THROTTLE_MS);
  }

  /**
   * Broadcast audio buffer to all open language gates (Audio Fan-Out).
   * Buffers up to 15s of audio during reconnects so zero words are lost.
   * @param {Buffer} pcmBuffer - 16kHz, 16-bit mono PCM audio
   */
  broadcastAudio(pcmBuffer) {
    if (!this.isOperational || !pcmBuffer || !Buffer.isBuffer(pcmBuffer)) return;
    if (pcmBuffer.length < 2) return;

    // Enforce 16-bit PCM even byte alignment
    if (pcmBuffer.length % 2 !== 0) {
      pcmBuffer = pcmBuffer.subarray(0, pcmBuffer.length - 1);
    }
    if (pcmBuffer.length < 2) return;

    // Inactivity watchdog: Auto-close all gates if no audio is received for 30 seconds
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      if (this.activeGates.size > 0) {
        console.log('[Soniox] Inactivity timeout: 30s with no microphone audio. Auto-closing gates to preserve credits ($0 cost).');
        this.closeAllGates();
      }
    }, 30000);

    // Ensure English gate is open on-demand if no gates exist
    if (this.activeGates.size === 0) {
      this.ensureGate('en');
    }

    for (const [lang, gate] of this.activeGates.entries()) {
      gate.lastAudioAt = Date.now();

      if (gate.status === 'open' && gate.ws && gate.ws.readyState === WebSocket.OPEN) {
        if (gate.ws.bufferedAmount > 512 * 1024) {
          console.warn(`[Soniox Gate ${lang}] WebSocket backpressure warning (${gate.ws.bufferedAmount} bytes buffered)`);
        }
        try {
          gate.ws.send(pcmBuffer, { binary: true });
        } catch (e) {
          console.warn(`[Soniox Gate ${lang}] Send error:`, e.message);
        }
      } else if (gate.queuedBytes < MAX_QUEUE_BYTES) {
        // Socket connecting or reconnecting: buffer audio frames, NEVER drop them!
        gate.audioQueue.push(pcmBuffer);
        gate.queuedBytes += pcmBuffer.length;
      }
    }
  }

  // Alias
  pushAudio(pcmBuffer) {
    this.broadcastAudio(pcmBuffer);
  }

  /**
   * Close a specific language gate gracefully.
   * @param {string} langCode
   */
  closeGate(langCode) {
    const gate = this.activeGates.get(langCode);
    if (!gate) return;

    gate.closing = true;
    clearInterval(gate.keepaliveTimer);
    if (gate.emitTimer) clearTimeout(gate.emitTimer);

    // Commit any remaining text before closing
    this.commit(gate, 'gate-close', true);

    if (gate.ws) {
      try {
        if (gate.ws.readyState === WebSocket.OPEN) {
          gate.ws.send(JSON.stringify({ type: 'finalize' }));
          gate.ws.send(''); // Empty frame = graceful end of audio stream
          setTimeout(() => {
            try { gate.ws.close(1000, 'Gate closed by manager'); } catch (_) {}
          }, 500);
        } else {
          gate.ws.close();
        }
      } catch (_) {}
    }

    gate.status = 'closed';
    this.activeGates.delete(langCode);
  }

  /**
   * Close all active gates (e.g. when sermon ends or server shuts down).
   */
  closeAllGates() {
    if (this._inactivityTimer) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
    for (const timer of this.gateRemovalTimers.values()) {
      clearTimeout(timer);
    }
    this.gateRemovalTimers.clear();

    for (const lang of Array.from(this.activeGates.keys())) {
      this.closeGate(lang);
    }
  }

  /**
   * Get current gate status for monitoring and health check.
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
