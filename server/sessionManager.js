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
    this.subscribers = new Map(); // sessionId -> Set of { ws, role, language, clientId }
    this.history = this.loadHistory();
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
      tvFontSize: 'medium', // 'small' | 'medium' | 'large' | 'xlarge'
      tvCapacity: 12, // 3X previous capacity (was 4, now 12 lines)
      tvAudioEnabled: false, // Default: OFF (Admin controlled)
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

  updateTvSettings(sessionId, { fontSize, capacity, audioEnabled } = {}) {
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
    this.broadcastToSession(sessionId, {
      type: 'TV_SETTINGS_UPDATE',
      tvFontSize: session.tvFontSize,
      tvCapacity: session.tvCapacity,
      tvAudioEnabled: session.tvAudioEnabled
    });
    return session;
  }

  getAllActiveSessions() {
    return Array.from(this.sessions.values()).map(session => {
      const stats = this.getSessionStats(session.id);
      return {
        ...session,
        stats
      };
    });
  }

  startSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.status = 'active';
    session.startedAt = new Date().toISOString();
    this.broadcastToSession(sessionId, {
      type: 'SESSION_STATUS',
      status: 'active',
      mosqueName: session.mosqueName,
      startedAt: session.startedAt
    });
    return session;
  }

  pauseSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.status = 'paused';
    this.broadcastToSession(sessionId, {
      type: 'SESSION_STATUS',
      status: 'paused',
      mosqueName: session.mosqueName
    });
    return session;
  }

  endSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.status = 'ended';
    session.endedAt = new Date().toISOString();

    const durationSeconds = session.startedAt
      ? Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 1000)
      : 0;

    const stats = this.getSessionStats(sessionId);

    // Save to archive
    const archiveRecord = {
      id: session.id,
      mosqueName: session.mosqueName,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSeconds,
      totalTranscripts: session.transcripts.length,
      totalAyahsDetected: session.detectedAyahs.length,
      peakListeners: stats.totalAttendees,
      transcripts: session.transcripts,
      detectedAyahs: session.detectedAyahs
    };

    this.history.unshift(archiveRecord);
    this.saveHistory();

    this.broadcastToSession(sessionId, {
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
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    const resolvedDevice = deviceType || (role === 'tv' ? 'computer' : 'phone');
    const subscriber = { ws, role, language, clientId, deviceType: resolvedDevice, lastPing: Date.now() };
    this.subscribers.get(sessionId).add(subscriber);

    // Update attendee counts
    this.notifyStatsUpdate(sessionId);

    return subscriber;
  }

  touchSubscriber(sessionId, ws, { deviceType = null, language = null, clientId = null } = {}) {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.ws === ws) {
        sub.lastPing = Date.now();
        if (deviceType) sub.deviceType = deviceType;
        if (language) sub.language = language;
        if (clientId) sub.clientId = clientId;
        break;
      }
    }
  }

  recordHttpPing(sessionId, { clientId, role = 'attendee', deviceType = 'phone', language = 'en' }) {
    if (!this.httpClients) this.httpClients = new Map();
    if (!this.httpClients.has(sessionId)) {
      this.httpClients.set(sessionId, new Map());
    }
    const sessionMap = this.httpClients.get(sessionId);
    sessionMap.set(clientId, {
      role,
      deviceType: deviceType || 'phone',
      language: language || 'en',
      lastSeen: Date.now()
    });
    this.notifyStatsUpdate(sessionId);
  }

  getActiveHttpClients(sessionId) {
    if (!this.httpClients || !this.httpClients.has(sessionId)) return new Map();
    const sessionMap = this.httpClients.get(sessionId);
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
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    for (const sub of subs) {
      if (sub.ws === ws) {
        subs.delete(sub);
        break;
      }
    }

    this.notifyStatsUpdate(sessionId);
  }

  updateSubscriberLanguage(sessionId, ws, newLanguage) {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.ws === ws) {
        sub.language = newLanguage;
        break;
      }
    }
    this.notifyStatsUpdate(sessionId);
  }

  getSessionStats(sessionId) {
    const subs = this.subscribers.get(sessionId) || new Set();
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
    const activeHttp = this.getActiveHttpClients(sessionId);
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
    const stats = this.getSessionStats(sessionId);
    this.broadcastToSession(sessionId, {
      type: 'STATS_UPDATE',
      stats
    });
    this.broadcastToSession(sessionId, {
      type: 'SESSION_STATS',
      stats
    });
  }

  /**
   * Broadcasts a payload to all or specific roles in the session
   */
  broadcastToSession(sessionId, payload, roleFilter = null) {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    const message = JSON.stringify(payload);
    for (const sub of subs) {
      if (roleFilter && sub.role !== roleFilter) continue;
      if (sub.ws.readyState === 1 /* OPEN */) {
        sub.ws.send(message);
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
    const session = this.getSession(sessionId);
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

    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    for (const sub of subs) {
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
        // Admin gets the full packet with ayah detection details
        sub.ws.send(JSON.stringify({
          type: 'ADMIN_TRANSCRIPT',
          arabic: arabicText,
          translations,
          ayah: ayahData || null,
          timestamp
        }));
      }
    }
  }
}

module.exports = {
  SessionManager
};
