/**
 * Speech-to-Text (STT) Service
 * Integrates with Gladia V2 Real-Time WebSocket API
 *
 * Architecture:
 *  - Key Pool Manager: 12 Gladia keys are round-robin allocated to sessions.
 *  - Each live session gets its own dedicated Gladia V2 WebSocket connection.
 *  - On key exhaustion / connection failure, the pool automatically rotates
 *    to the next available key (failover is seamless).
 *  - Supports up to 10 concurrent sessions.
 *
 * Gladia V2 Handshake:
 *  POST https://api.gladia.io/v2/live  -> { id, url }
 *  WSS connect to `url` (token embedded in query string)
 *
 * Events emitted:
 *  'transcript'  { text, isFinal, language, sessionLabel, source }
 *  'translation' { arabic, translations, sessionLabel, source }
 */

const https  = require('https');
const WebSocket = require('ws');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Realistic Friday Khutbah Speech Script — for demos / offline simulation
// ---------------------------------------------------------------------------
const SIMULATED_KHUTBAH_SCRIPT = [
  { arabic: 'إنَّ الحَمْدَ لِلَّهِ نَحْمَدُهُ وَنَسْتَعِينُهُ وَنَسْتَغْفِرُهُ', type: 'sermon' },
  { arabic: 'وَنَعُوذُ بِاللَّهِ مِنْ شُرُورِ أَنْفُسِنَا وَمِنْ سَيِّئَاتِ أَعْمَالِنَا', type: 'sermon' },
  { arabic: 'مَنْ يَهْدِهِ اللَّهُ فَلَا مُضِلَّ لَهُ، وَمَنْ يُضْلِلْ فَلَا هَادِيَ لَهُ', type: 'sermon' },
  { arabic: 'وَأَشْهَدُ أَنْ لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، وَأَشْهَدُ أَنَّ مُحَمَّدًا عَبْدُهُ وَرَسُولُهُ', type: 'sermon' },
  { arabic: 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ حَقَّ تُقَاتِهِ وَلَا تَمُوتُنَّ إِلَّا وَأَنتُم مُّسْلِمُونَ', type: 'quran' },
  { arabic: 'أَيُّهَا الإِخْوَةُ الكِرَامُ، اتَّقُوا اللَّهَ تَعَالَى وَاعْلَمُوا أَنَّ الحَيَاةَ الدُّنْيَا دَارُ امْتِحَانٍ', type: 'sermon' },
  { arabic: 'وَإِنَّ الصَّبْرَ عَلَى الطَّاعَةِ وَعَنِ المَعْصِيَةِ مِفْتَاحُ الفَرَجِ وَالرِّضَا', type: 'sermon' },
  { arabic: 'فَإِنَّ مَعَ الْعُسْرِ يُسْرًا، إِنَّ مَعَ الْعُسْرِ يُسْرًا', type: 'quran' },
  { arabic: 'فَاسْتَغْفِرُوا اللَّهَ يَغْفِرْ لَكُمْ، إِنَّهُ هُوَ الغَفُورُ الرَّحِيمُ', type: 'sermon' },
  { arabic: 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ وَقُولُوا قَوْلًا سَدِيدًا', type: 'quran' },
  { arabic: 'اللَّهُمَّ اغْفِرْ لِلْمُسْلِمِينَ وَالْمُسْلِمَاتِ، الأَحْيَاءِ مِنْهُمْ وَالأَمْوَاتِ', type: 'dua' }
];

// ---------------------------------------------------------------------------
// Gladia V2 API helper — POST /v2/live to get a session URL
// ---------------------------------------------------------------------------
function getGladiaSessionUrl(apiKey, config) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(config);
    const options = {
      hostname: 'api.gladia.io',
      path: '/v2/live',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Gladia-Key': apiKey
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 201 && parsed.url) {
            resolve(parsed.url);
          } else if (res.statusCode === 429) {
            reject(new Error('RATE_LIMIT'));
          } else {
            reject(new Error('Gladia init failed: ' + res.statusCode + ' ' + data));
          }
        } catch (e) {
          reject(new Error('Gladia parse error: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Gladia Key Pool Manager
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_SESSIONS = 10;

class GladiaKeyPool {
  constructor(keys) {
    this.pool = keys
      .filter(k => k && k.trim().length > 0 && !k.includes('your_') && !k.includes('placeholder'))
      .map((key, idx) => ({
        key: key.trim(),
        index: idx,
        status: 'available',  // 'available' | 'in-use' | 'exhausted' | 'failed'
        exhaustedUntil: null,
        sessionIds: new Set()
      }));
    this.roundRobinCursor = 0;
    console.log('[GladiaPool] Initialized with ' + this.pool.length + ' keys.');
  }

  getNextAvailableKey() {
    const now = Date.now();
    // Re-enable keys whose exhaustion period has passed
    for (const entry of this.pool) {
      if (entry.status === 'exhausted' && entry.exhaustedUntil && now > entry.exhaustedUntil) {
        entry.status = 'available';
        entry.exhaustedUntil = null;
        console.log('[GladiaPool] Key #' + entry.index + ' is available again.');
      }
    }

    const activeSessions = this.pool.reduce((sum, e) => sum + e.sessionIds.size, 0);
    if (activeSessions >= MAX_CONCURRENT_SESSIONS) {
      console.warn('[GladiaPool] Hard cap of ' + MAX_CONCURRENT_SESSIONS + ' concurrent sessions reached.');
      return null;
    }

    for (let attempt = 0; attempt < this.pool.length; attempt++) {
      const idx = (this.roundRobinCursor + attempt) % this.pool.length;
      const entry = this.pool[idx];
      if ((entry.status === 'available' || entry.status === 'in-use') && entry.sessionIds.size === 0) {
        this.roundRobinCursor = (idx + 1) % this.pool.length;
        return entry;
      }
    }
    console.warn('[GladiaPool] No available keys.');
    return null;
  }

  allocate(sessionLabel) {
    const entry = this.getNextAvailableKey();
    if (!entry) return null;
    entry.status = 'in-use';
    entry.sessionIds.add(sessionLabel);
    console.log('[GladiaPool] Key #' + entry.index + ' allocated to "' + sessionLabel + '".');
    return entry;
  }

  release(keyIndex, sessionLabel) {
    const entry = this.pool[keyIndex];
    if (!entry) return;
    entry.sessionIds.delete(sessionLabel);
    if (entry.sessionIds.size === 0 && entry.status === 'in-use') {
      entry.status = 'available';
    }
    console.log('[GladiaPool] Key #' + keyIndex + ' released from "' + sessionLabel + '".');
  }

  markExhausted(keyIndex, exhaustedUntilMs) {
    const entry = this.pool[keyIndex];
    if (!entry) return;
    entry.status = 'exhausted';
    entry.exhaustedUntil = exhaustedUntilMs || null;
    entry.sessionIds.clear();
    console.warn('[GladiaPool] Key #' + keyIndex + ' marked exhausted.');
  }

  markFailed(keyIndex) {
    const entry = this.pool[keyIndex];
    if (!entry) return;
    entry.status = 'failed';
    entry.sessionIds.clear();
    console.error('[GladiaPool] Key #' + keyIndex + ' marked failed.');
  }

  getStats() {
    const counts = { available: 0, 'in-use': 0, exhausted: 0, failed: 0 };
    for (const e of this.pool) counts[e.status] = (counts[e.status] || 0) + 1;
    return { total: this.pool.length, ...counts };
  }
}

// ---------------------------------------------------------------------------
// Per-session Gladia V2 Live Connection
// ---------------------------------------------------------------------------
class GladiaLiveSession {
  constructor(sessionLabel, keyEntry, keyPool, emitter, targetLangs) {
    this.sessionLabel = sessionLabel;
    this.keyEntry     = keyEntry;
    this.keyPool      = keyPool;
    this.emitter      = emitter;
    this.targetLangs  = targetLangs;
    this.ws           = null;
    this.wssUrl       = null;
    this.ready        = false;
    this.destroyed    = false;
    this._audioQueue  = [];
  }

  async connect() {
    const config = {
      encoding: 'wav/pcm',
      sample_rate: 16000,
      bit_depth: 16,
      channels: 1,
      language_config: {
        languages: null,
        code_switching: true
      },
      translation_config: {
        target_languages: this.targetLangs,
        model: 'base'
      }
    };

    console.log('[GladiaSession:' + this.sessionLabel + '] Requesting V2 URL (Key #' + this.keyEntry.index + ')...');

    try {
      this.wssUrl = await getGladiaSessionUrl(this.keyEntry.key, config);
    } catch (err) {
      if (err.message === 'RATE_LIMIT') {
        this.keyPool.markExhausted(this.keyEntry.index);
      } else {
        this.keyPool.markFailed(this.keyEntry.index);
      }
      throw err;
    }

    console.log('[GladiaSession:' + this.sessionLabel + '] URL received. Connecting WSS...');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wssUrl);

      const timeout = setTimeout(() => {
        reject(new Error('Gladia WebSocket connect timeout'));
      }, 15000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[GladiaSession:' + this.sessionLabel + '] WebSocket OPEN');
        this.ready = true;
        if (this._audioQueue.length > 0) {
          for (const chunk of this._audioQueue) this.ws.send(chunk);
          this._audioQueue = [];
        }
        resolve();
      });

      this.ws.on('message', (data) => { this._handleMessage(data); });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[GladiaSession:' + this.sessionLabel + '] Error: ' + err.message);
        this.ready = false;
        reject(err);
      });

      this.ws.on('close', (code) => {
        clearTimeout(timeout);
        this.ready = false;
        console.log('[GladiaSession:' + this.sessionLabel + '] Closed (code ' + code + ')');
        if (!this.destroyed) {
          this.keyPool.release(this.keyEntry.index, this.sessionLabel);
        }
      });
    });
  }

  _handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString());
      const type = msg.type;

      if (type === 'transcript') {
        const d = msg.data || {};
        const utterance = d.utterance || {};
        const text = (utterance.text || '').trim();
        if (text && d.is_final) {
          console.log('[GladiaSession:' + this.sessionLabel + '] Transcript: "' + text + '"');
          this.emitter.emit('transcript', {
            text,
            isFinal: true,
            language: utterance.language || 'ar',
            source: 'gladia',
            sessionLabel: this.sessionLabel
          });
        }
        return;
      }

      if (type === 'translation') {
        const d = msg.data || {};
        const results = d.results || [];
        if (d.is_final && results.length > 0) {
          const translations = {};
          for (const r of results) {
            if (r.language && r.text) translations[r.language] = r.text.trim();
          }
          const arabic = (d.utterance && d.utterance.text) ? d.utterance.text.trim() : '';
          if (Object.keys(translations).length > 0) {
            console.log('[GladiaSession:' + this.sessionLabel + '] Translation for: ' + Object.keys(translations).join(', '));
            this.emitter.emit('translation', {
              arabic,
              translations,
              source: 'gladia',
              sessionLabel: this.sessionLabel
            });
          }
        }
        return;
      }

      if (type === 'error') {
        const code = (msg.data && msg.data.code) || 'UNKNOWN';
        const message = (msg.data && msg.data.message) || JSON.stringify(msg);
        console.error('[GladiaSession:' + this.sessionLabel + '] Error [' + code + ']: ' + message);
        if (code === 'USAGE_LIMIT_REACHED' || code === 'QUOTA_EXCEEDED') {
          this.keyPool.markExhausted(this.keyEntry.index);
        }
        return;
      }

      if (type === 'session_ack' || type === 'ready') {
        console.log('[GladiaSession:' + this.sessionLabel + '] Acknowledged.');
      }

    } catch (err) {
      console.error('[GladiaSession:' + this.sessionLabel + '] Parse error: ' + err.message);
    }
  }

  sendAudio(buffer) {
    if (this.destroyed) return;
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    } else if (this._audioQueue.length < 100) {
      this._audioQueue.push(buffer);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    this._audioQueue = [];
    this.keyPool.release(this.keyEntry.index, this.sessionLabel);
    if (this.ws) {
      try { this.ws.close(1000, 'Session ended'); } catch (_) {}
      this.ws = null;
    }
    console.log('[GladiaSession:' + this.sessionLabel + '] Destroyed.');
  }
}

// ---------------------------------------------------------------------------
// STTService — public API consumed by server/index.js
// ---------------------------------------------------------------------------
class STTService extends EventEmitter {
  /**
   * @param {string|string[]} gladiaKeys - single key, comma-separated string, or array
   */
  constructor(gladiaKeys) {
    super();

    let keys = [];
    if (Array.isArray(gladiaKeys)) {
      keys = gladiaKeys;
    } else if (typeof gladiaKeys === 'string' && gladiaKeys.includes(',')) {
      keys = gladiaKeys.split(',');
    } else if (typeof gladiaKeys === 'string' && gladiaKeys.trim()) {
      keys = [gladiaKeys];
    }

    this.keyPool      = new GladiaKeyPool(keys);
    this.liveSessions = new Map();       // sessionLabel -> GladiaLiveSession
    this.targetLangs  = ['en', 'bn', 'ur', 'fr', 'zh', 'tr', 'id', 'so', 'uz'];

    // Simulation state
    this.simulationInterval = null;
    this.simulationIndex    = 0;

    const stats = this.keyPool.getStats();
    console.log('[STT] GladiaKeyPool ready — ' + stats.available + ' available, ' + stats.total + ' total.');
  }

  // Legacy compatibility: called by server/index.js on startup
  async initSession() {
    const stats = this.keyPool.getStats();
    if (stats.total === 0) {
      console.log('[STT] No Gladia keys configured. Simulation / local relay mode only.');
    } else {
      console.log('[STT] Ready. ' + stats.total + ' Gladia keys available. Sessions open on first audio.');
    }
  }

  // Simulation controls (admin panel uses these)
  startSimulation(intervalMs) {
    intervalMs = intervalMs || 4500;
    this.stopSimulation();
    this.simulationIndex = 0;
    console.log('[STT] Starting Khutbah simulation...');

    const emitNext = () => {
      if (this.simulationIndex >= SIMULATED_KHUTBAH_SCRIPT.length) {
        this.simulationIndex = 0;
      }
      const item = SIMULATED_KHUTBAH_SCRIPT[this.simulationIndex++];
      this.emit('transcript', {
        text: item.arabic,
        isFinal: true,
        source: 'simulator',
        speechType: item.type
      });
    };

    emitNext();
    this.simulationInterval = setInterval(emitNext, intervalMs);
  }

  stopSimulation() {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
      console.log('[STT] Simulation stopped.');
    }
  }

  // --------------------------------------------------------------------------
  // Open / close individual live sessions
  // --------------------------------------------------------------------------

  /**
   * Opens a dedicated Gladia V2 live session for a microphone source.
   * Automatically picks the next available key with failover.
   *
   * @param {string} [sessionLabel='default']
   * @returns {Promise<GladiaLiveSession|null>}
   */
  async openLiveSession(sessionLabel) {
    sessionLabel = sessionLabel || 'default';

    // Return existing open session
    if (this.liveSessions.has(sessionLabel)) {
      const existing = this.liveSessions.get(sessionLabel);
      if (!existing.destroyed && existing.ready) return existing;
      existing.destroy();
      this.liveSessions.delete(sessionLabel);
    }

    const keyEntry = this.keyPool.allocate(sessionLabel);
    if (!keyEntry) {
      console.warn('[STT] Cannot open "' + sessionLabel + '" — no available keys.');
      return null;
    }

    const session = new GladiaLiveSession(
      sessionLabel, keyEntry, this.keyPool, this, this.targetLangs
    );
    this.liveSessions.set(sessionLabel, session);

    try {
      await session.connect();
      return session;
    } catch (err) {
      console.error('[STT] Session "' + sessionLabel + '" failed: ' + err.message);
      this.liveSessions.delete(sessionLabel);

      // One automatic failover attempt
      const nextKey = this.keyPool.allocate(sessionLabel);
      if (nextKey) {
        console.log('[STT] Failover attempt for "' + sessionLabel + '" with Key #' + nextKey.index + '...');
        const failoverSession = new GladiaLiveSession(
          sessionLabel, nextKey, this.keyPool, this, this.targetLangs
        );
        this.liveSessions.set(sessionLabel, failoverSession);
        try {
          await failoverSession.connect();
          return failoverSession;
        } catch (failErr) {
          console.error('[STT] Failover also failed for "' + sessionLabel + '": ' + failErr.message);
          this.liveSessions.delete(sessionLabel);
        }
      }
      return null;
    }
  }

  /**
   * Closes a specific live session.
   * @param {string} [sessionLabel='default']
   */
  closeLiveSession(sessionLabel) {
    sessionLabel = sessionLabel || 'default';
    const session = this.liveSessions.get(sessionLabel);
    if (session) {
      session.destroy();
      this.liveSessions.delete(sessionLabel);
    }
  }

  /**
   * Sends a raw audio buffer to the named live session.
   * Opens the session lazily on the first audio chunk.
   *
   * @param {Buffer} buffer
   * @param {string} [sessionLabel='default']
   */
  async sendAudioChunk(buffer, sessionLabel) {
    sessionLabel = sessionLabel || 'default';
    if (!Buffer.isBuffer(buffer)) return;

    const stats = this.keyPool.getStats();
    if (stats.total === 0) return; // No keys — simulation mode

    let session = this.liveSessions.get(sessionLabel);
    if (!session || session.destroyed) {
      // Lazy open: first audio chunk triggers the connection
      session = await this.openLiveSession(sessionLabel);
    }

    if (session) {
      session.sendAudio(buffer);
    }
  }

  /**
   * Status of key pool and all live sessions.
   */
  getStatus() {
    const sessions = [];
    for (const [label, sess] of this.liveSessions.entries()) {
      sessions.push({
        label,
        ready: sess.ready,
        destroyed: sess.destroyed,
        keyIndex: sess.keyEntry ? sess.keyEntry.index : null
      });
    }
    return { keyPool: this.keyPool.getStats(), sessions };
  }

  destroy() {
    this.stopSimulation();
    for (const session of this.liveSessions.values()) session.destroy();
    this.liveSessions.clear();
  }
}

module.exports = {
  STTService,
  SIMULATED_KHUTBAH_SCRIPT
};
