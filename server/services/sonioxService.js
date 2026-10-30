/**
 * Soniox Real-Time Speech Translation Service
 * 
 * Implements the "Dynamic Language Gates" Audio Fan-Out Architecture with Multi-Session Isolation:
 *  - Full Multi-Session Support: gates and audio streams are partitioned per sessionId.
 *  - Two or more sessions running on different laptops never cross-talk or conflict.
 *  - Dynamic On-Demand Gates: opens 1 Soniox WebSocket stream per active language in each session.
 *  - Audio Fan-Out: duplicates PCM audio in server memory and pipes to active gates of the target session.
 *  - Append-and-Replace Live Streaming:
 *      * Finalized tokens (is_final: true) are appended permanently to stable text.
 *      * Provisional tokens (is_final: false) replace the live tail every frame.
 *      * Continuous sentence commits on punctuation (. ! ? ؟ ۔) without waiting for pauses.
 *      * Monotonic sequence (seq) numbering for rock-solid ordering and deduplication.
 *  - Zero Data Loss on Reconnect: commits pending text on disconnect and buffers up to
 *    15s of audio frames during socket reconnects.
 *  - Keepalive pings every 5s prevent idle stream timeouts during Khutbah pauses.
 *  - Auto-closes gates on inactivity ($0 cost for unused languages) per session.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const SONIOX_WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const DEFAULT_MODEL = process.env.SONIOX_MODEL || 'stt-rt-v5';
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

// Soniox only accepts base ISO-639-1 codes (no regional subtags like zh-TW).
// Map app language codes → Soniox accepted translation target codes.
const SONIOX_LANG_MAP = {
  'zh-TW': 'zh',  // Traditional Chinese → same Soniox zh gate (Mandarin model handles both scripts)
};

// Whitelist of translation target languages supported natively by Soniox.
// Languages not in this list (e.g. 'so' Somali, 'uz' Uzbek) reject with HTTP 400
// and are automatically translated via the server's neural translation pipeline.
const SONIOX_SUPPORTED_TRANSLATION_LANGUAGES = new Set([
  'en', 'tr', 'ur', 'bn', 'fr', 'zh', 'zh-TW', 'id', 'es', 'de', 'it', 'pt', 'ar', 'ru', 'ja', 'ko', 'hi'
]);

let s2t = null;
try {
  s2t = require('chinese-s2t').s2t;
} catch (_) {}

const PARTIAL_THROTTLE_MS = 60;
const KEEPALIVE_MS = 5000;
const MAX_QUEUE_BYTES = 16000 * 2 * 15; // 15 seconds of 16kHz 16-bit PCM (480,000 bytes)
const SENTENCE_END = /[.!?؟。！？۔]\s*/g; // Sentence punctuation (incl. Arabic ؟, Urdu ۔, Chinese 。！？)
const MAX_SEGMENT_CHARS = 220; // Force commit during long continuous speech without punctuation
const MAX_CONCURRENT_GATES = parseInt(process.env.SONIOX_MAX_CONCURRENT_STREAMS || '1', 10);

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
    // Key format: "${sessionId}:${langCode}" -> gate object
    this.activeGates = new Map();
    // Key format: "${sessionId}:${langCode}" -> timer
    this.gateRemovalTimers = new Map();
    // Key format: "${sessionId}" -> timer (auto-close inactive session gates)
    this.sessionInactivityTimers = new Map();
    // Key format: "${sessionId}" -> { lang: string, hints: string[] }
    this.sessionSourceLanguages = new Map();
    this.isRateLimited = false;
    this.rateLimitedUntil = 0;
    this.isOperational = this.validateApiKey(this.apiKey);

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

  /**
   * Returns true only if Soniox has a healthy, connected WebSocket gate actively streaming for sessionId.
   * If Soniox is disconnected, in cool-off, or rate-limited, returns false so hot fallback (browser_mic/Gladia) activates.
   */
  isStreaming(sessionId = null) {
    if (!this.isOperational) return false;
    if (this.isRateLimited && Date.now() < this.rateLimitedUntil) return false;

    for (const [_, gate] of this.activeGates.entries()) {
      if (!sessionId || gate.sessionId === sessionId) {
        if (gate.status === 'open' && gate.ws && gate.ws.readyState === WebSocket.OPEN) {
          return true;
        }
      }
    }
    return false;
  }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
    this.isOperational = this.validateApiKey(this.apiKey);
  }

  getSourceLanguageHints(sessionId) {
    const entry = this.sessionSourceLanguages.get(sessionId || 'default');
    return entry ? entry.hints : [];
  }

  getSourceLanguage(sessionId) {
    const entry = this.sessionSourceLanguages.get(sessionId || 'default');
    return entry ? entry.lang : 'auto';
  }

  setSourceLanguage(sessionIdOrLang, maybeLang) {
    const sid = maybeLang ? sessionIdOrLang : 'default';
    const langCode = maybeLang || sessionIdOrLang;

    if (!langCode || langCode === 'auto') {
      this.sessionSourceLanguages.set(sid, { lang: 'auto', hints: [] });
      console.log(`[Soniox] Source language for session "${sid}" set to: auto-detect`);
    } else {
      const normalised = SONIOX_LANG_MAP[langCode] || langCode;
      this.sessionSourceLanguages.set(sid, { lang: langCode, hints: [normalised] });
      console.log(`[Soniox] Source language for session "${sid}" set to: ${normalised} (${langCode})`);
    }

    // Reconnect all active gates for this session to apply new language_hints
    for (const [_, gate] of this.activeGates.entries()) {
      if (gate.sessionId === sid && (gate.status === 'open' || gate.status === 'connecting')) {
        console.log(`[Soniox Gate ${gate.gateKey}] Reconnecting to apply new source language...`);
        this.commit(gate, 'source-language-change', true);
        try { gate.ws && gate.ws.close(1000, 'Source language changed'); } catch (_) {}
      }
    }
  }

  /**
   * Build clean, documented Soniox real-time config payload.
   */
  buildConfig(lang, sessionId = 'default') {
    const sonioxLang = SONIOX_LANG_MAP[lang] || lang;
    const config = {
      api_key: this.apiKey,
      model: DEFAULT_MODEL,
      audio_format: 'pcm_s16le',
      sample_rate: SAMPLE_RATE,
      num_channels: NUM_CHANNELS,
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
        target_language: sonioxLang
      }
    };
    const hints = this.getSourceLanguageHints(sessionId);
    if (hints && hints.length > 0) {
      config.language_hints = hints;
    }
    return config;
  }

  /**
   * Synchronize active language gates with the currently required languages for a session.
   * Debounces gate closure by 10s to prevent thrashing when attendees reload/switch.
   * @param {string|Array<string>} sessionIdOrLangs - Target sessionId or list of languages
   * @param {Array<string>|Set<string>} maybeLangs - List of active language codes if sessionId passed first
   */
  syncGates(sessionIdOrLangs, maybeLangs) {
    if (!this.isOperational) return;

    const sid = (maybeLangs !== undefined && typeof sessionIdOrLangs === 'string')
      ? sessionIdOrLangs
      : 'default';
    const rawLangs = maybeLangs !== undefined ? maybeLangs : sessionIdOrLangs;
    const reqSet = new Set(Array.from(rawLangs || []).filter(l => l && typeof l === 'string'));

    // 1. Open newly requested gates for this session and cancel pending close timers
    for (const lang of reqSet) {
      const gateKey = `${sid}:${lang}`;
      if (this.gateRemovalTimers.has(gateKey)) {
        clearTimeout(this.gateRemovalTimers.get(gateKey));
        this.gateRemovalTimers.delete(gateKey);
      }
      this.ensureGate(sid, lang);
    }

    // 2. Debounce closure for languages in this session that have 0 listeners
    for (const [gateKey, gate] of this.activeGates.entries()) {
      if (gate.sessionId !== sid) continue;
      if (!reqSet.has(gate.lang) && !this.gateRemovalTimers.has(gateKey)) {
        const timer = setTimeout(() => {
          this.gateRemovalTimers.delete(gateKey);
          console.log(`[Soniox Gate] 0 listeners remaining for "${gate.lang}" in session "${sid}" — closing gate ($0 cost).`);
          this.closeGate(sid, gate.lang);
        }, 10000); // 10-second debounce
        this.gateRemovalTimers.set(gateKey, timer);
      }
    }
  }

  isLanguageSupported(lang) {
    if (!lang) return false;
    return SONIOX_SUPPORTED_TRANSLATION_LANGUAGES.has(lang);
  }

  /**
   * Ensures a dedicated Soniox WebSocket stream exists for a specific session and target language.
   * @param {string} sessionIdOrLang
   * @param {string} maybeLang
   */
  ensureGate(sessionIdOrLang, maybeLang) {
    if (!this.isOperational) return null;

    const sid = maybeLang ? sessionIdOrLang : 'default';
    const langCode = maybeLang || sessionIdOrLang;
    if (!langCode) return null;

    // If currently cooling off from 429, do not open new sockets
    if (this.isRateLimited) {
      if (Date.now() < this.rateLimitedUntil) {
        return null;
      }
      this.isRateLimited = false;
    }

    if (!SONIOX_SUPPORTED_TRANSLATION_LANGUAGES.has(langCode)) {
      // Do not open a Soniox gate for unsupported target languages (prevents 400 rejection loops)
      return null;
    }

    // STRICT ORGANIZATION CONCURRENCY PROTECTION:
    // Close any gates from older/different sessions to avoid exceeding the 1-stream limit
    for (const [key, g] of Array.from(this.activeGates.entries())) {
      if (g.sessionId !== sid) {
        console.log(`[Soniox] Closing stale gate "${key}" of session "${g.sessionId}" to maintain organization concurrency limit.`);
        this.closeGate(g.sessionId, g.lang);
      }
    }

    const gateKey = `${sid}:${langCode}`;
    const existing = this.activeGates.get(gateKey);
    if (existing) {
      if (existing.status === 'open' || existing.status === 'connecting') {
        return existing;
      }
      // If reconnecting or in error, cancel pending reconnect timer to prevent gate duplication
      if (existing.reconnectTimer) {
        clearTimeout(existing.reconnectTimer);
        existing.reconnectTimer = null;
      }
      try { existing.ws && existing.ws.close(); } catch (_) {}
    }

    // Check if we reached the maximum concurrent streams allowed for this account
    if (this.activeGates.size >= MAX_CONCURRENT_GATES) {
      console.log(`[Soniox] Concurrency cap (${MAX_CONCURRENT_GATES}) reached. Target language "${langCode}" will be handled via fast neural translation.`);
      return null;
    }

    console.log(`[Soniox Gate] Opening dynamic gate for session "${sid}" target language: "${langCode}"...`);

    const gate = {
      gateKey,
      sessionId: sid,
      lang: langCode,
      ws: null,
      status: 'connecting',
      closing: false,
      audioQueue: [],
      queuedBytes: 0,
      lastAudioAt: Date.now(),
      // Translation buffers:
      stableTr: '',
      liveTr: '',
      // Original speech buffers:
      stableOr: '',
      liveOr: '',
      currentOriginalText: '',
      currentTranslatedText: '',
      seq: 0,
      emitTimer: null,
      keepaliveTimer: null,
      reconnectAttempts: 0,
      createdAt: Date.now()
    };

    this.activeGates.set(gateKey, gate);
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
        console.log(`[Soniox Gate] Connected & ready for session "${gate.sessionId}" language "${gate.lang}".`);
        this.emit('connected', { sessionId: gate.sessionId, lang: gate.lang });

        // Send start configuration payload
        ws.send(JSON.stringify(this.buildConfig(gate.lang, gate.sessionId)));

        // Flush any audio captured while socket was connecting/reconnecting -> zero lost speech
        if (gate.audioQueue.length > 0) {
          console.log(`[Soniox Gate ${gate.gateKey}] Flushing ${gate.audioQueue.length} buffered audio chunks (${gate.queuedBytes} bytes)...`);
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
        console.warn(`[Soniox Gate ${gate.gateKey}] WS Error:`, err.message);
      });

      ws.on('close', (code, reason) => {
        clearInterval(gate.keepaliveTimer);

        // Never lose finalized words: commit everything we currently have
        this.commit(gate, 'socket-close', /* includeLive */ true);

        if (gate.closing || !this.isOperational) {
          gate.status = 'closed';
          return;
        }

        // If rate-limited, do not reconnect immediately to avoid DDoS loop
        if (this.isRateLimited && Date.now() < this.rateLimitedUntil) {
          gate.status = 'closed';
          gate.closing = true;
          this.activeGates.delete(gate.gateKey);
          return;
        }

        gate.status = 'reconnecting';
        const delay = Math.min(1000 * Math.pow(2, gate.reconnectAttempts++), 30000);
        console.warn(`[Soniox Gate ${gate.gateKey}] WS Closed (${code}: ${reason || 'Blip'}); auto-reconnect in ${delay}ms...`);

        gate.reconnectTimer = setTimeout(() => {
          gate.reconnectTimer = null;
          if (!gate.closing && this.isOperational && !this.isRateLimited && this.activeGates.has(gate.gateKey)) {
            this.connectGate(gate);
          }
        }, delay);
      });

    } catch (err) {
      console.error(`[Soniox Gate ${gate.gateKey}] Connection exception:`, err.message);
      gate.status = 'error';
    }
  }

  /**
   * Parse Soniox streaming tokens and dispatch in real time.
   */
  onSonioxMessage(gate, raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.error_code || data.error_message || data.error) {
      console.error(`[Soniox Gate ${gate.gateKey}] API Error:`, data.error_code, data.error_message || data.error);
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
      if (data.error_code === 429 || (typeof data.error_message === 'string' && data.error_message.includes('limit for real-time transcription has been exceeded'))) {
        console.warn(`[Soniox Gate ${gate.gateKey}] Soniox 429 limit exceeded (rate or concurrency). Pausing Soniox reconnects for 30s to allow rate limits to reset. Hot fallback to browser mic / Gladia.`);
        this.isRateLimited = true;
        this.rateLimitedUntil = Date.now() + 30000;
        gate.closing = true;
        gate.status = 'closed';
        if (gate.reconnectTimer) {
          clearTimeout(gate.reconnectTimer);
          gate.reconnectTimer = null;
        }
        try { gate.ws && gate.ws.close(); } catch (_) {}
        this.activeGates.delete(gate.gateKey);
        this.emit('degraded', { sessionId: gate.sessionId, reason: '429_rate_limit' });
        return;
      }
      // If error is 400 or invalid target_language, close permanently without looping reconnects
      if (data.error_code === 400 || (typeof data.error_message === 'string' && data.error_message.includes('target_language'))) {
        console.warn(`[Soniox Gate ${gate.gateKey}] Unsupported language target "${gate.lang}". Closing gate permanently without reconnecting.`);
        gate.closing = true;
        gate.status = 'closed';
        if (gate.reconnectTimer) clearTimeout(gate.reconnectTimer);
        try { gate.ws.close(); } catch (_) {}
        this.activeGates.delete(gate.gateKey);
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
      let tokenText = t.text;
      if (isTr && gate.lang === 'zh-TW' && s2t) {
        tokenText = s2t(tokenText);
      }
      if (t.is_final) {
        // FINAL: append permanently once
        if (isTr) gate.stableTr += tokenText;
        else gate.stableOr += tokenText;
      } else {
        // NON-FINAL: provisional tail, replaced every message
        if (isTr) liveTr += tokenText;
        else liveOr += tokenText;
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

  handleSonioxMessage(gate, data) {
    this.onSonioxMessage(gate, Buffer.from(JSON.stringify(data)));
  }

  /**
   * Commit full sentences as soon as they are finalized, without waiting for the speaker to pause.
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

  emitCommit(gate, translated, arabic, reason = 'sentence') {
    translated = (translated || '').trim();
    arabic = (arabic || '').trim();
    if (!translated && !arabic) return;

    const seq = ++gate.seq;
    const ts = new Date().toISOString();

    // 1. Emit token_stream with isFinal: true so TV display locks in the completed sentence immediately
    this.emit('token_stream', {
      sessionId: gate.sessionId,
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
      sessionId: gate.sessionId,
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
      sessionId: gate.sessionId,
      lang: gate.lang,
      seq,
      translated,
      arabic,
      reason,
      t: Date.now()
    });
  }

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
        sessionId: gate.sessionId,
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
        sessionId: gate.sessionId,
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

  touchSessionAudio(sid) {
    if (!this.sessionInactivityTimers) this.sessionInactivityTimers = new Map();
    if (this.sessionInactivityTimers.has(sid)) {
      clearTimeout(this.sessionInactivityTimers.get(sid));
    }
    // 45-second inactivity timeout so gates close promptly when session audio stops, preventing concurrency lockouts
    const timer = setTimeout(() => {
      this.sessionInactivityTimers.delete(sid);
      console.log(`[Soniox] Inactivity timeout: 45 seconds of silence for session "${sid}". Closing gates.`);
      this.closeSessionGates(sid);
    }, 45000);
    this.sessionInactivityTimers.set(sid, timer);
  }

  /**
   * Broadcast audio buffer to open language gates belonging to the target session ONLY.
   * Buffers up to 15s of audio during reconnects so zero words are lost.
   * @param {Buffer} pcmBuffer - 16kHz, 16-bit mono PCM audio
   * @param {string|null} sessionId - Session ID the audio belongs to
   */
  broadcastAudio(pcmBuffer, sessionId = null) {
    if (!this.isOperational || !pcmBuffer || !Buffer.isBuffer(pcmBuffer)) return;
    if (pcmBuffer.length < 2) return;

    if (pcmBuffer.length % 2 !== 0) {
      pcmBuffer = pcmBuffer.subarray(0, pcmBuffer.length - 1);
    }
    if (pcmBuffer.length < 2) return;

    if (!sessionId || sessionId === 'default') {
      return;
    }

    const sid = sessionId;

    // Touch session inactivity timer
    this.touchSessionAudio(sid);

    // If no gate exists yet for this session (e.g. after pause or fresh start), request full resync
    let sessionHasGates = false;
    for (const [_, gate] of this.activeGates.entries()) {
      if (gate.sessionId === sid) {
        sessionHasGates = true;
        break;
      }
    }
    if (!sessionHasGates) {
      this.emit('session_needs_sync', sid);
      this.ensureGate(sid, 'en');
    }

    for (const [_, gate] of this.activeGates.entries()) {
      // STRICT SESSION ISOLATION: Never send audio to gates of another session!
      if (gate.sessionId !== sid) {
        continue;
      }

      gate.lastAudioAt = Date.now();

      if (gate.status === 'open' && gate.ws && gate.ws.readyState === WebSocket.OPEN) {
        if (gate.ws.bufferedAmount > 512 * 1024) {
          console.warn(`[Soniox Gate ${gate.gateKey}] WebSocket backpressure warning (${gate.ws.bufferedAmount} bytes buffered)`);
        }
        try {
          gate.ws.send(pcmBuffer, { binary: true });
        } catch (e) {
          console.warn(`[Soniox Gate ${gate.gateKey}] Send error:`, e.message);
        }
      } else if (gate.queuedBytes < MAX_QUEUE_BYTES) {
        gate.audioQueue.push(pcmBuffer);
        gate.queuedBytes += pcmBuffer.length;
      }
    }
  }

  pushAudio(pcmBuffer, sessionId = null) {
    this.broadcastAudio(pcmBuffer, sessionId);
  }

  /**
   * Close a specific language gate gracefully for a session.
   */
  closeGate(sessionIdOrLang, maybeLang) {
    const sid = maybeLang ? sessionIdOrLang : 'default';
    const langCode = maybeLang || sessionIdOrLang;
    const gateKey = `${sid}:${langCode}`;
    const gate = this.activeGates.get(gateKey);
    if (!gate) return;

    gate.closing = true;
    clearInterval(gate.keepaliveTimer);
    if (gate.emitTimer) clearTimeout(gate.emitTimer);
    if (gate.reconnectTimer) {
      clearTimeout(gate.reconnectTimer);
      gate.reconnectTimer = null;
    }

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
    this.activeGates.delete(gateKey);
  }

  /**
   * Close all active gates for a specific session.
   */
  closeSessionGates(sessionId) {
    const sid = sessionId || 'default';
    if (this.sessionInactivityTimers && this.sessionInactivityTimers.has(sid)) {
      clearTimeout(this.sessionInactivityTimers.get(sid));
      this.sessionInactivityTimers.delete(sid);
    }
    for (const [key, gate] of Array.from(this.activeGates.entries())) {
      if (gate.sessionId === sid) {
        this.closeGate(gate.sessionId, gate.lang);
      }
    }
  }

  /**
   * Close all active gates across all sessions.
   */
  closeAllGates() {
    if (this.sessionInactivityTimers) {
      for (const timer of this.sessionInactivityTimers.values()) {
        clearTimeout(timer);
      }
      this.sessionInactivityTimers.clear();
    }
    for (const timer of this.gateRemovalTimers.values()) {
      clearTimeout(timer);
    }
    this.gateRemovalTimers.clear();

    for (const [_, gate] of Array.from(this.activeGates.entries())) {
      this.closeGate(gate.sessionId, gate.lang);
    }
    this.activeGates.clear();
  }

  getStatus(sessionId = null) {
    const activeLanguages = new Set();
    let gateCount = 0;
    for (const [_, gate] of this.activeGates.entries()) {
      if (!sessionId || gate.sessionId === sessionId) {
        activeLanguages.add(gate.lang);
        gateCount++;
      }
    }
    return {
      operational: this.isOperational,
      activeGateCount: gateCount,
      activeLanguages: Array.from(activeLanguages),
      sourceLang: sessionId ? this.getSourceLanguage(sessionId) : 'auto',
      estimatedHourlyCost: (gateCount * 0.18).toFixed(2) + ' USD/hr'
    };
  }
}

module.exports = new SonioxGateManager();
