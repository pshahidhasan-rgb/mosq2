/**
 * Mosque Khutbah Session Manager
 * Coordinates live sessions, connected clients, attendees, and broadcast distribution
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const isVercel = !!process.env.VERCEL;
const DATA_DIR = isVercel ? '/tmp' : path.join(__dirname, '../data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Ensure data directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (err) {
  console.warn('[Session] Notice on data directory creation:', err.message);
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.sessionAliases = new Map([
      ['myo-youth-8f3a9e', 'myo-youth'],
      ['jumuah-live-4b2c1d', 'jumuah-live']
    ]);
    this.subscribers = new Map(); // sessionId -> Set of { ws, role, language, clientId }
    this.history = this.loadHistory();
  }

  getCanonicalId(sessionId) {
    if (!sessionId) return 'myo-youth';
    const clean = String(sessionId).trim().toLowerCase();
    if (this.sessionAliases && this.sessionAliases.has(clean)) {
      return this.sessionAliases.get(clean);
    }
    if (this.sessions.has(clean)) {
      return clean;
    }
    // Prefix / base slug match support: e.g. 'myo-youth' matches 'myo-youth-8f3a9e' and vice versa
    for (const [key, sess] of this.sessions.entries()) {
      if (key === clean || key.startsWith(clean) || clean.startsWith(key)) {
        return sess.id;
      }
    }
    return clean;
  }

  loadHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[Session] Failed to read history file:', err.message);
    }
    return [];
  }

  saveHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2), 'utf8');
    } catch (err) {
      console.error('[Session] Failed to save history:', err.message);
    }
  }

  /**
   * Creates or gets a live khutbah session
   */
  async createSession({
    sessionId = 'default-khutbah',
    mosqueName = 'Masjid Al-Noor',
    primaryLanguage = 'en',
    hostUrl = 'http://localhost:3000'
  } = {}) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const joinUrl = `${hostUrl}/join.html?session=${sessionId}`;
    const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, {
      margin: 1,
      width: 280,
      color: { dark: '#064e3b', light: '#ffffff' }
    });

    const session = {
      id: sessionId,
      mosqueName,
      primaryLanguage,
      speakerLanguage: 'auto', // 'auto' | 'ar-SA' | 'en-US' | etc.
      tvLanguage: 'en', // Display TV target language
      tvFontSize: 'medium', // 'small' | 'medium' | 'large' | 'xlarge'
      tvCapacity: 12, // 3X previous capacity (was 4, now 12 lines)
      tvAudioEnabled: false, // Default: OFF (Admin controlled)
      tvShowQr: true, // Default: ON (Admin controlled)
      status: 'idle', // idle, active, paused, ended
      startedAt: null,
      endedAt: null,
      transcripts: [],
      detectedAyahs: [],
      joinUrl,
      qrCodeDataUrl,
      languages: ['en', 'bn', 'ur', 'fr', 'zh', 'tr'],
      createdAt: new Date().toISOString()
    };

    this.sessions.set(sessionId, session);
    this.subscribers.set(sessionId, new Set());
    return session;
  }

  getSession(sessionId) {
    if (!sessionId) return null;
    const actualId = this.getCanonicalId(sessionId);
    if (this.sessions.has(actualId)) {
      return this.sessions.get(actualId);
    }
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    // Prefix / base slug match support: e.g. 'myo-youth' matches 'myo-youth-8f3a9e'
    for (const [key, sess] of this.sessions.entries()) {
      if (key.startsWith(sessionId) || sessionId.startsWith(key)) {
        return sess;
      }
    }
    return null;
  }

  async updateHostUrl(sessionId, hostUrl) {
    const session = this.getSession(sessionId);
    if (!session || !hostUrl) return session;
    if (session.hostUrl !== hostUrl) {
      session.hostUrl = hostUrl;
      session.joinUrl = `${hostUrl}/join.html?session=${sessionId}`;
      try {
        session.qrCodeDataUrl = await QRCode.toDataURL(session.joinUrl, {
          margin: 1,
          width: 280,
          color: { dark: '#064e3b', light: '#ffffff' }
        });
      } catch (err) {
        console.warn('[Session] QR code refresh failed:', err.message);
      }
    }
    return session;
  }

  setSpeakerLanguage(sessionId, language) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.speakerLanguage = language || 'auto';
    return session;
  }

  setTvLanguage(sessionId, language) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.tvLanguage = language || 'en';
    return session;
  }

  updateTvSettings(sessionId, { fontSize, capacity, audioEnabled, showQr } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (fontSize !== undefined && fontSize !== null) {
      session.tvFontSize = fontSize;
    }
    if (capacity !== undefined && capacity !== null) {
      session.tvCapacity = Number(capacity);
    }
    if (audioEnabled !== undefined && audioEnabled !== null) {
      session.tvAudioEnabled = Boolean(audioEnabled);
    }
    if (showQr !== undefined && showQr !== null) {
      session.tvShowQr = Boolean(showQr);
    }
    this.broadcastToSession(sessionId, {
      type: 'TV_SETTINGS_UPDATE',
      tvFontSize: session.tvFontSize,
      tvCapacity: session.tvCapacity,
      tvAudioEnabled: session.tvAudioEnabled,
      tvShowQr: session.tvShowQr !== undefined ? session.tvShowQr : true
    });
    return session;
  }

  /**
   * Archives a completed khutbah run for a session with date, time, display TV translations, and attendance
   */
  archiveSessionRun(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || !session.transcripts || session.transcripts.length === 0) {
      return null;
    }

    const now = new Date();
    const started = session.startedAt ? new Date(session.startedAt) : now;
    const durationSeconds = Math.max(0, Math.round((now - started) / 1000));
    const mins = Math.floor(durationSeconds / 60);
    const secs = durationSeconds % 60;
    const durationDisplay = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    const dateDisplay = started.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const timeDisplay = started.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });

    const stats = this.getSessionStats(session.id);
    const tvLang = session.tvLanguage || session.primaryLanguage || 'en';

    // Format transcripts: original speech + translation tailored to the display TV language
    const formattedTranscripts = session.transcripts.map(t => {
      const orig = t.arabic || t.original || '';
      let trans = '';
      if (t.translations && typeof t.translations === 'object') {
        trans = t.translations[tvLang] || t.translations.en || Object.values(t.translations)[0] || '';
      } else if (typeof t.translated === 'string') {
        trans = t.translated;
      } else if (typeof t.translation === 'string') {
        trans = t.translation;
      }
      return {
        original: orig,
        translation: trans,
        timestamp: t.timestamp || new Date().toISOString()
      };
    });

    const runId = `hist_${session.id}_${Date.now()}`;
    const archiveRecord = {
      id: runId,
      sessionId: session.id,
      mosqueName: session.mosqueName,
      startedAt: started.toISOString(),
      endedAt: now.toISOString(),
      dateDisplay,
      timeDisplay,
      durationSeconds,
      durationDisplay,
      totalTranscripts: formattedTranscripts.length,
      totalAyahsDetected: (session.detectedAyahs && session.detectedAyahs.length) || 0,
      attendance: {
        total: stats.totalAttendees || 0,
        phoneAttendees: stats.phoneAttendees || 0,
        computerDisplays: stats.computerDisplays || 0
      },
      speakerLanguage: session.speakerLanguage || 'auto',
      tvLanguage: tvLang,
      transcripts: formattedTranscripts
    };

    this.history.unshift(archiveRecord);
    if (this.history.length > 200) {
      this.history = this.history.slice(0, 200);
    }
    this.saveHistory();

    // Reset transcripts and detected Ayahs so next run starts clean without duplicate archival
    session.transcripts = [];
    session.detectedAyahs = [];

    return archiveRecord;
  }

  /**
   * Retrieves all historical runs for a specific session
   */
  getSessionHistory(sessionId) {
    const session = this.getSession(sessionId);
    const actualId = session ? session.id : sessionId;
    const cleanId = (actualId || '').toLowerCase().trim();

    return this.history
      .filter(h => {
        const sid = (h.sessionId || h.id || '').toLowerCase().trim();
        return sid === cleanId;
      })
      .map(h => {
        // Normalize older records on the fly for consistent UI
        const started = h.startedAt ? new Date(h.startedAt) : new Date();
        const dateDisplay = h.dateDisplay || started.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
        const timeDisplay = h.timeDisplay || started.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const durationDisplay = h.durationDisplay || (h.durationSeconds ? `${Math.floor(h.durationSeconds / 60)}m ${h.durationSeconds % 60}s` : '0m 0s');
        const tvLang = h.tvLanguage || 'en';

        const transcripts = (h.transcripts || []).map(t => {
          const orig = t.original || t.arabic || '';
          let trans = t.translation || '';
          if (!trans && t.translations && typeof t.translations === 'object') {
            trans = t.translations[tvLang] || t.translations.en || Object.values(t.translations)[0] || '';
          }
          return {
            original: orig,
            translation: trans,
            timestamp: t.timestamp || started.toISOString()
          };
        });

        const totalAttendance = h.attendance?.total ?? h.peakListeners ?? 0;
        const phoneAttendees = h.attendance?.phoneAttendees ?? totalAttendance;
        const computerDisplays = h.attendance?.computerDisplays ?? 0;

        return {
          id: h.id,
          sessionId: h.sessionId || h.id,
          mosqueName: h.mosqueName || 'Mosque Session',
          startedAt: h.startedAt,
          endedAt: h.endedAt,
          dateDisplay,
          timeDisplay,
          durationDisplay,
          durationSeconds: h.durationSeconds || 0,
          totalTranscripts: transcripts.length,
          totalAttendance,
          phoneAttendees,
          computerDisplays,
          tvLanguage: tvLang,
          transcripts
        };
      });
  }

  deleteSessionHistoryEntry(sessionId, historyId) {
    const beforeCount = this.history.length;
    this.history = this.history.filter(h => h.id !== historyId);
    if (this.history.length !== beforeCount) {
      this.saveHistory();
      return true;
    }
    return false;
  }

  clearSessionText(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    
    // Archive any transcripts before clearing so sermon history is preserved
    if (session.transcripts && session.transcripts.length > 0) {
      this.archiveSessionRun(session.id);
    }

    session.transcripts = [];
    session.detectedAyahs = [];
    this.broadcastToSession(session.id, {
      type: 'SESSION_CLEAR_TEXT',
      sessionId: session.id
    });
    return session;
  }

  deleteSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return false;
    const actualId = session.id;

    this.broadcastToSession(actualId, {
      type: 'SESSION_DELETED',
      sessionId: actualId
    });

    this.subscribers.delete(actualId);
    if (this.httpClients) this.httpClients.delete(actualId);
    this.sessions.delete(actualId);

    this.history = this.history.filter(h => h.sessionId !== actualId && h.id !== actualId);
    this.saveHistory();

    return true;
  }

  getAllActiveSessions() {
    return Array.from(this.sessions.values()).map(session => {
      const stats = this.getSessionStats(session.id);
      const historyRuns = this.getSessionHistory(session.id);
      return {
        ...session,
        stats,
        historyCount: historyRuns.length
      };
    });
  }

  startSession(sessionId) {
    const actualId = this.getCanonicalId(sessionId);
    const session = this.getSession(actualId);
    if (!session) return null;
    
    // If there were already transcripts from an earlier run on a different day, archive them first
    if (session.transcripts && session.transcripts.length > 0) {
      this.archiveSessionRun(actualId);
      session.transcripts = [];
      session.detectedAyahs = [];
    }

    session.status = 'active';
    session.startedAt = new Date().toISOString();
    session.endedAt = null;
    this.broadcastToSession(actualId, {
      type: 'SESSION_STATUS',
      status: 'active',
      mosqueName: session.mosqueName,
      startedAt: session.startedAt
    });
    return session;
  }

  pauseSession(sessionId) {
    const actualId = this.getCanonicalId(sessionId);
    const session = this.getSession(actualId);
    if (!session) return null;
    session.status = 'paused';
    this.broadcastToSession(actualId, {
      type: 'SESSION_STATUS',
      status: 'paused',
      mosqueName: session.mosqueName
    });
    return session;
  }

  endSession(sessionId) {
    const actualId = this.getCanonicalId(sessionId);
    const session = this.getSession(actualId);
    if (!session) return null;
    session.status = 'ended';
    session.endedAt = new Date().toISOString();

    let archiveRecord = null;
    if (session.transcripts && session.transcripts.length > 0) {
      archiveRecord = this.archiveSessionRun(actualId);
    }

    this.broadcastToSession(actualId, {
      type: 'SESSION_STATUS',
      status: 'ended',
      mosqueName: session.mosqueName,
      summary: archiveRecord
    });

    return session;
  }

  /**
   * Adds a WebSocket connection to the session room
   */
  addSubscriber(sessionId, ws, { role = 'attendee', language = 'en', clientId = '', deviceType = null } = {}) {
    const actualId = this.getCanonicalId(sessionId);
    if (!this.subscribers.has(actualId)) {
      this.subscribers.set(actualId, new Set());
    }
    const resolvedDevice = deviceType || (role === 'tv' ? 'computer' : 'phone');
    const subscriber = { ws, role, language, clientId, deviceType: resolvedDevice, lastPing: Date.now() };
    this.subscribers.get(actualId).add(subscriber);

    if (role === 'tv' && language) {
      const session = this.getSession(actualId);
      if (session) session.tvLanguage = language;
    }

    // Update attendee counts
    this.notifyStatsUpdate(actualId);

    return subscriber;
  }

  touchSubscriber(sessionId, ws, { deviceType = null, language = null, clientId = null } = {}) {
    const actualId = this.getCanonicalId(sessionId);
    const subs = this.subscribers.get(actualId);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.ws === ws) {
        sub.lastPing = Date.now();
        if (deviceType) sub.deviceType = deviceType;
        if (language) {
          sub.language = language;
          if (sub.role === 'tv') {
            const session = this.getSession(actualId);
            if (session) session.tvLanguage = language;
          }
        }
        if (clientId) sub.clientId = clientId;
        break;
      }
    }
  }

  recordHttpPing(sessionId, { clientId, role = 'attendee', deviceType = 'phone', language = 'en' }) {
    const actualId = this.getCanonicalId(sessionId);
    if (!this.httpClients) this.httpClients = new Map();
    if (!this.httpClients.has(actualId)) {
      this.httpClients.set(actualId, new Map());
    }
    const sessionMap = this.httpClients.get(actualId);
    sessionMap.set(clientId, {
      role,
      deviceType: deviceType || 'phone',
      language: language || 'en',
      lastSeen: Date.now()
    });
    if (role === 'tv' && language) {
      const session = this.getSession(actualId);
      if (session) session.tvLanguage = language;
    }
    this.notifyStatsUpdate(actualId);
  }

  getActiveHttpClients(sessionId) {
    const actualId = this.getCanonicalId(sessionId);
    if (!this.httpClients || !this.httpClients.has(actualId)) return new Map();
    const sessionMap = this.httpClients.get(actualId);
    const now = Date.now();
    const active = new Map();
    for (const [cid, info] of sessionMap.entries()) {
      if (now - info.lastSeen < 25000) {
        active.set(cid, info);
      } else {
        sessionMap.delete(cid);
      }
    }
    return active;
  }

  removeSubscriber(sessionId, ws) {
    const actualId = this.getCanonicalId(sessionId);
    const subs = this.subscribers.get(actualId);
    if (!subs) return;

    for (const sub of subs) {
      if (sub.ws === ws) {
        subs.delete(sub);
        break;
      }
    }

    this.notifyStatsUpdate(actualId);
  }

  updateSubscriberLanguage(sessionId, ws, newLanguage) {
    const actualId = this.getCanonicalId(sessionId);
    const subs = this.subscribers.get(actualId);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.ws === ws) {
        sub.language = newLanguage;
        if (sub.role === 'tv') {
          const session = this.getSession(actualId);
          if (session) session.tvLanguage = newLanguage;
        }
        break;
      }
    }
    this.notifyStatsUpdate(actualId);
  }

  getSessionStats(sessionId) {
    const actualId = this.getCanonicalId(sessionId);
    const subs = this.subscribers.get(actualId) || new Set();
    let phoneAttendees = 0;
    let computerDisplays = 0;
    let totalAttendees = 0;
    let tvDisplays = 0;
    const languageCounts = {};
    const seenClientKeys = new Set();

    for (const sub of subs) {
      // Exclude admin pulpit console from viewer counts
      if (sub.role === 'admin') continue;

      const clientKey = sub.clientId || sub.ws;
      if (clientKey && seenClientKeys.has(clientKey)) continue;
      if (clientKey) seenClientKeys.add(clientKey);

      if (sub.role === 'tv') {
        tvDisplays++;
        computerDisplays++;
      } else {
        totalAttendees++;
        if (sub.deviceType === 'phone') {
          phoneAttendees++;
        } else {
          computerDisplays++;
        }
      }

      if (sub.language) {
        languageCounts[sub.language] = (languageCounts[sub.language] || 0) + 1;
      }
    }

    // Also factor in any HTTP-polling clients not connected to WebSocket
    const activeHttp = this.getActiveHttpClients(actualId);
    for (const [cid, info] of activeHttp.entries()) {
      if (info.role === 'admin') continue;
      if (seenClientKeys.has(cid)) continue;
      seenClientKeys.add(cid);

      if (info.role === 'tv') {
        tvDisplays++;
        computerDisplays++;
      } else {
        totalAttendees++;
        if (info.deviceType === 'phone') {
          phoneAttendees++;
        } else {
          computerDisplays++;
        }
      }
      if (info.language) {
        languageCounts[info.language] = (languageCounts[info.language] || 0) + 1;
      }
    }

    return {
      phoneAttendees,
      computerDisplays,
      totalAttendees,
      tvDisplays,
      totalTVDisplays: computerDisplays,
      totalBrowsers: phoneAttendees + computerDisplays,
      languageCounts
    };
  }

  notifyStatsUpdate(sessionId) {
    const actualId = this.getCanonicalId(sessionId);
    const stats = this.getSessionStats(actualId);
    this.broadcastToSession(actualId, {
      type: 'STATS_UPDATE',
      stats
    });
    this.broadcastToSession(actualId, {
      type: 'SESSION_STATS',
      stats
    });
  }

  /**
   * Broadcasts a payload to all or specific roles in the session
   */
  broadcastToSession(sessionId, payload, roleFilter = null) {
    const actualId = this.getCanonicalId(sessionId);
    const message = JSON.stringify(payload);

    const targetSubSets = [this.subscribers.get(actualId)];
    if (sessionId && sessionId !== actualId && this.subscribers.has(sessionId)) {
      targetSubSets.push(this.subscribers.get(sessionId));
    }

    const seenWs = new Set();
    for (const subs of targetSubSets) {
      if (!subs) continue;
      for (const sub of subs) {
        if (seenWs.has(sub.ws)) continue;
        seenWs.add(sub.ws);
        if (roleFilter && sub.role !== roleFilter) continue;
        if (sub.ws.readyState === 1 /* OPEN */) {
          sub.ws.send(message);
        }
      }
    }
  }

  /**
   * Broadcasts translated speech and audio to attendees tailored to their selected language
   */
  broadcastTranslations(sessionId, {
    arabicText,
    translations,
    ayahData,
    audioByLanguage = {},
    timestamp = new Date().toISOString()
  }) {
    const actualId = this.getCanonicalId(sessionId);
    const session = this.getSession(actualId);
    if (session) {
      session.transcripts.push({
        arabic: arabicText,
        translations,
        ayah: ayahData || null,
        timestamp
      });
      if (ayahData) {
        session.detectedAyahs.push({
          reference: ayahData.reference,
          arabicUthmani: ayahData.arabicUthmani,
          timestamp
        });
      }
    }

    const targetSubSets = [this.subscribers.get(actualId)];
    if (sessionId && sessionId !== actualId && this.subscribers.has(sessionId)) {
      targetSubSets.push(this.subscribers.get(sessionId));
    }

    const seenWs = new Set();
    for (const subs of targetSubSets) {
      if (!subs) continue;

      for (const sub of subs) {
        if (seenWs.has(sub.ws)) continue;
        seenWs.add(sub.ws);
        if (sub.ws.readyState !== 1) continue;

        if (sub.role === 'tv') {
          // TV display gets Arabic + full multi-language translations map so client can display any selected language
          const tvLang = sub.language || (session ? session.primaryLanguage : 'en');
          sub.ws.send(JSON.stringify({
            type: 'LIVE_SUBTITLE',
            arabic: arabicText,
            translations,
            translated: (translations && translations[tvLang]) || (translations && translations.en) || arabicText,
            language: tvLang,
            ayah: ayahData || null,
            timestamp
          }));
        } else if (sub.role === 'attendee') {
          // Attendee receives their chosen language + audio buffer
          const attendeeLang = sub.language || 'en';
          const translatedText = (translations && translations[attendeeLang]) || (translations && translations.en) || arabicText;
          const audio = audioByLanguage[attendeeLang] || null;

          sub.ws.send(JSON.stringify({
            type: 'LIVE_SUBTITLE',
            arabic: arabicText,
            translations,
            translated: translatedText,
            language: attendeeLang,
            ayah: ayahData ? {
              ...ayahData,
              translation: ayahData.translations[attendeeLang] || ayahData.translations.en
            } : null,
            audio,
            timestamp
          }));
        } else if (sub.role === 'admin') {
          // Admin gets both ADMIN_TRANSCRIPT and LIVE_SUBTITLE
          sub.ws.send(JSON.stringify({
            type: 'LIVE_SUBTITLE',
            arabic: arabicText,
            translations,
            ayah: ayahData || null,
            timestamp
          }));
        }
      }
    }
  }
}

module.exports = {
  SessionManager
};
