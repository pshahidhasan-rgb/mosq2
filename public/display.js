// MosqAI - Live TV Split-Screen Script (Enhanced with Dropdown, Safe QR & History Persistence)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'myo-youth';

const VALID_LANGS = ['en', 'uz', 'tr', 'ur', 'bn', 'fr', 'zh', 'zh-TW', 'id', 'so'];
let userExplicitlySelectedLang = false;

// Determine initial language:
// 1. URL param (?lang=)
// 2. Saved preference in localStorage ('mosq_tv_lang')
// 3. Default fallback: 'en'
let targetLang = 'en';
if (urlParams.get('lang') && VALID_LANGS.includes(urlParams.get('lang'))) {
  targetLang = urlParams.get('lang');
  userExplicitlySelectedLang = true;
} else {
  try {
    const saved = localStorage.getItem('mosq_tv_lang');
    if (saved && VALID_LANGS.includes(saved)) {
      targetLang = saved;
      userExplicitlySelectedLang = true;
    }
  } catch (e) {}
}

let currentMosqueName = 'MYO YOUTH CENTER';
let ws = null;

function getTvClientId() {
  let cid = '';
  try {
    cid = localStorage.getItem('mosq_tv_client_id');
    if (!cid) {
      cid = 'tv_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
      localStorage.setItem('mosq_tv_client_id', cid);
    }
  } catch (e) {
    cid = 'tv_' + Math.random().toString(36).substring(2, 9);
  }
  return cid;
}
const tvClientId = getTvClientId();

// Track timestamps rendered
const seenTimestamps = new Set();
let feedSyncInterval = null;

// BCP-47 language tag mappings for supported languages
const LANG_BCP47_MAP = {
  en: 'en-US',
  uz: 'uz-UZ',
  tr: 'tr-TR',
  ur: 'ur-PK',
  bn: 'bn-BD',
  fr: 'fr-FR',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  id: 'id-ID',
  so: 'so-SO',
  ar: 'ar-SA'
};

const MALE_VOICE_KEYWORDS = [
  'male', 'david', 'mark', 'george', 'guy', 'paul', 'daniel', 'thomas',
  'alex', 'fred', 'oliver', 'arthur', 'aaron', 'james', 'nathan', 'rishi',
  'tarik', 'mehdi', 'salman', 'ali', 'hakan', 'berk', 'cem', 'deep', 'baritone'
];

const FEMALE_VOICE_KEYWORDS = [
  'female', 'zira', 'susan', 'samantha', 'victoria', 'karen', 'moira',
  'fiona', 'tessa', 'veena', 'yelda', 'filiz', 'amira', 'zeina', 'salma',
  'camille', 'clara', 'marie', 'anna', 'helena', 'eva', 'laura', 'lucia'
];

function getBestMaleVoice(langCode) {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;

  const targetPrefix = (langCode || 'en').toLowerCase().split('-')[0];

  const matchingVoices = voices.filter(v => {
    const vLang = (v.lang || '').toLowerCase().replace('_', '-');
    return vLang.startsWith(targetPrefix);
  });

  const pool = matchingVoices.length > 0 ? matchingVoices : voices;

  for (const voice of pool) {
    const nameLower = voice.name.toLowerCase();
    const uriLower = (voice.voiceURI || '').toLowerCase();
    const isExplicitMale = MALE_VOICE_KEYWORDS.some(kw => nameLower.includes(kw) || uriLower.includes(kw));
    const isExplicitFemale = FEMALE_VOICE_KEYWORDS.some(kw => nameLower.includes(kw) || uriLower.includes(kw));
    if (isExplicitMale && !isExplicitFemale) {
      return voice;
    }
  }

  for (const voice of pool) {
    const nameLower = voice.name.toLowerCase();
    const uriLower = (voice.voiceURI || '').toLowerCase();
    const isExplicitFemale = FEMALE_VOICE_KEYWORDS.some(kw => nameLower.includes(kw) || uriLower.includes(kw));
    if (!isExplicitFemale) {
      return voice;
    }
  }

  return pool[0] || null;
}

let isTvAudioEnabled = false; // Default: OFF (Admin controlled)
let isTvQrVisible = true; // Default: ON (Admin controlled)

function setTvQrVisibility(visible) {
  isTvQrVisible = visible !== false;
  const qrWidget = document.getElementById('qr-widget');
  if (qrWidget) {
    qrWidget.style.display = isTvQrVisible ? 'flex' : 'none';
  }
}

function setTvAudioState(enabled) {
  isTvAudioEnabled = Boolean(enabled);
  if (!isTvAudioEnabled && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function playTvBrowserAudio(text, langCode) {
  if (!isTvAudioEnabled) return;
  if (!('speechSynthesis' in window)) return;
  if (!text || typeof text !== 'string') return;

  const cleanText = text.trim();
  if (!cleanText) return;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    const bcpTag = LANG_BCP47_MAP[langCode] || langCode || 'en-US';
    utterance.lang = bcpTag;

    const maleVoice = getBestMaleVoice(langCode);
    if (maleVoice) {
      utterance.voice = maleVoice;
    }
    utterance.pitch = 0.92;
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.warn('[TV Audio] Speech error:', err);
  }
}

// User interaction audio unlocker for display screen
let hasUnlockedTvAudio = false;
function unlockTvAudio() {
  if (hasUnlockedTvAudio) return;
  hasUnlockedTvAudio = true;
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.resume();
      const silent = new SpeechSynthesisUtterance('');
      silent.volume = 0;
      window.speechSynthesis.speak(silent);
    }
  } catch (e) {}
}
document.addEventListener('click', unlockTvAudio);
document.addEventListener('keydown', unlockTvAudio);
document.addEventListener('touchstart', unlockTvAudio);


// Dynamic TV Font Size & Capacity Presets (Default is 3X previous capacity = 12 lines)
const TV_FONT_PRESETS = {
  small: { scale: 0.8, capacity: 18 },
  medium: { scale: 1.0, capacity: 12 }, // 3X previous capacity (was 4, now 12)
  large: { scale: 1.25, capacity: 8 },
  xlarge: { scale: 1.5, capacity: 5 }
};

let MAX_HISTORY = 12; // 3X previous capacity
let currentTvFontSize = 'medium';

function applyTvFontSize(fontSize, customCapacity = null, shouldScroll = true) {
  if (!fontSize) return;
  currentTvFontSize = fontSize;

  let scale = 1.0;
  let capacity = 12;

  if (typeof fontSize === 'string' && TV_FONT_PRESETS[fontSize]) {
    scale = TV_FONT_PRESETS[fontSize].scale;
    capacity = customCapacity ? Number(customCapacity) : TV_FONT_PRESETS[fontSize].capacity;
  } else if (!isNaN(Number(fontSize))) {
    const num = Number(fontSize);
    scale = num > 2 ? num / 100 : num;
    capacity = customCapacity ? Number(customCapacity) : Math.max(4, Math.round(12 / (scale || 1)));
  }

  MAX_HISTORY = capacity;
  document.documentElement.style.setProperty('--tv-font-scale', scale);

  try {
    localStorage.setItem('mosq_tv_font_size', fontSize);
    if (customCapacity) localStorage.setItem('mosq_tv_capacity', customCapacity);
  } catch (e) {}

  // Prune any excess history if capacity decreased
  while (recentFeedItems.length > MAX_HISTORY) {
    recentFeedItems.shift();
  }
  if (arabicFeed) {
    while (arabicFeed.children.length > MAX_HISTORY) {
      if (arabicFeed.firstElementChild) arabicFeed.firstElementChild.remove();
    }
  }
  if (transFeed) {
    while (transFeed.children.length > MAX_HISTORY) {
      if (transFeed.firstElementChild) transFeed.firstElementChild.remove();
    }
  }

  if (shouldScroll) {
    setTimeout(() => {
      if (arabicFeed && arabicFeed.parentElement) {
        arabicFeed.parentElement.scrollTo({ top: arabicFeed.parentElement.scrollHeight, behavior: 'smooth' });
      }
      if (transFeed && transFeed.parentElement) {
        transFeed.parentElement.scrollTo({ top: transFeed.parentElement.scrollHeight, behavior: 'smooth' });
      }
    }, 50);
  }
}

// Restore saved font size from localStorage if available
try {
  const savedTvSize = localStorage.getItem('mosq_tv_font_size');
  const savedTvCap = localStorage.getItem('mosq_tv_capacity');
  if (savedTvSize) applyTvFontSize(savedTvSize, savedTvCap, false);
} catch (e) {}

// History queue for re-rendering when user switches language
const recentFeedItems = [];
// Ayah overlay disabled
const activeAyahData = null;
const activeAyahFallbackTrans = null;

// DOM Elements
const mosqueNameEl = document.getElementById('mosque-name');
const sessionStatusBadge = document.getElementById('session-status-badge');
const stageStatusBanner = document.getElementById('stage-status-banner');
const stageStatusText = document.getElementById('stage-status-text');
const liveDotIndicator = document.getElementById('live-dot-indicator');
const targetLangSelect = document.getElementById('target-lang-select');
const arabicFeed = document.getElementById('arabic-feed');
const transFeed = document.getElementById('trans-feed');

function clearTvFeeds() {
  recentFeedItems = [];
  seenTimestamps.clear();
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  if (arabicFeed) {
    arabicFeed.innerHTML = '<div class="idle-placeholder">في انتظار بدء الخطبة...</div>';
  }
  if (transFeed) {
    transFeed.innerHTML = '<div class="idle-placeholder">Waiting for sermon to begin...</div>';
  }
}
const qrImg = document.getElementById('qr-img');
const ayahOverlay = document.getElementById('ayah-overlay');
const ayahRefEl = document.getElementById('ayah-reference');
const ayahArabicEl = document.getElementById('ayah-arabic');
const ayahTransEl = document.getElementById('ayah-trans');

// Initialize Dropdown Selection & Change Handler
if (targetLangSelect) {
  targetLangSelect.value = targetLang;

  targetLangSelect.addEventListener('change', () => {
    targetLang = targetLangSelect.value;
    userExplicitlySelectedLang = true;
    try {
      localStorage.setItem('mosq_tv_lang', targetLang);
    } catch (e) {}
    initQRCode();

    // Inform WebSocket of new TV language
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'CHANGE_LANGUAGE', language: targetLang }));
    }

    // Instantly re-render translations on TV screen in new language
    reRenderTranslationFeed();
  });
}

function updateTVStatusUI(status, mosqueName) {
  if (mosqueName) currentMosqueName = mosqueName;
  if (mosqueNameEl) mosqueNameEl.textContent = currentMosqueName;

  if (status === 'active') {
    if (sessionStatusBadge) {
      sessionStatusBadge.style.cssText = 'font-size: 0.72rem; font-weight: 800; padding: 0.2rem 0.6rem; border-radius: 999px; letter-spacing: 0.05em; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399;';
      sessionStatusBadge.textContent = 'LIVE';
    }
    if (liveDotIndicator) liveDotIndicator.style.display = 'block';
    if (stageStatusBanner) {
      stageStatusBanner.style.display = 'block';
      stageStatusBanner.style.background = 'rgba(16, 185, 129, 0.2)';
      stageStatusBanner.style.border = '1px solid rgba(16, 185, 129, 0.4)';
      stageStatusBanner.style.color = '#34d399';
      stageStatusText.textContent = `${currentMosqueName} — LIVE`;
    }
  } else if (status === 'paused') {
    if (sessionStatusBadge) {
      sessionStatusBadge.style.cssText = 'font-size: 0.72rem; font-weight: 800; padding: 0.2rem 0.6rem; border-radius: 999px; letter-spacing: 0.05em; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24;';
      sessionStatusBadge.textContent = 'PAUSED';
    }
    if (liveDotIndicator) liveDotIndicator.style.display = 'none';
    if (stageStatusBanner) {
      stageStatusBanner.style.display = 'block';
      stageStatusBanner.style.background = 'rgba(245, 158, 11, 0.25)';
      stageStatusBanner.style.border = '1px solid rgba(245, 158, 11, 0.4)';
      stageStatusBanner.style.color = '#fde68a';
      stageStatusText.textContent = `${currentMosqueName} — Live Translation Paused`;
    }
  } else if (status === 'ended') {
    if (sessionStatusBadge) {
      sessionStatusBadge.style.cssText = 'font-size: 0.72rem; font-weight: 800; padding: 0.2rem 0.6rem; border-radius: 999px; letter-spacing: 0.05em; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171;';
      sessionStatusBadge.textContent = 'ENDED';
    }
    if (liveDotIndicator) liveDotIndicator.style.display = 'none';
    if (stageStatusBanner) {
      stageStatusBanner.style.display = 'block';
      stageStatusBanner.style.background = 'rgba(239, 68, 68, 0.25)';
      stageStatusBanner.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      stageStatusBanner.style.color = '#fca5a5';
      stageStatusText.textContent = `${currentMosqueName} — Session Ended`;
    }
  } else {
    // idle
    if (sessionStatusBadge) {
      sessionStatusBadge.style.cssText = 'font-size: 0.72rem; font-weight: 800; padding: 0.2rem 0.6rem; border-radius: 999px; letter-spacing: 0.05em; background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.3); color: #94a3b8;';
      sessionStatusBadge.textContent = 'IDLE';
    }
    if (liveDotIndicator) liveDotIndicator.style.display = 'none';
    if (stageStatusBanner) stageStatusBanner.style.display = 'none';
  }
}

/**
 * Generate QR code pointing to current origin
 */
function initQRCode() {
  const joinUrl = `${window.location.origin}/join.html?session=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(targetLang)}`;
  if (qrImg) {
    qrImg.src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
    qrImg.onerror = () => {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(joinUrl)}`;
    };
  }
}

let activeStreamCleanups = [];

function clearActiveStreams() {
  activeStreamCleanups.forEach(fn => {
    try { fn(); } catch (e) {}
  });
  activeStreamCleanups = [];
}

/**
 * Stream words smoothly into an element with human-like cadence
 */
function streamWordsIntoElement(element, fullText, delayMs = 85, onComplete = null) {
  const words = fullText.split(/\s+/).filter(Boolean);
  element.textContent = '';
  element.classList.add('streaming');
  let idx = 0;

  const timer = setInterval(() => {
    if (idx < words.length) {
      const span = document.createElement('span');
      span.className = 'stream-word';
      span.textContent = (idx === 0 ? '' : ' ') + words[idx];
      element.appendChild(span);
      idx++;
      if (element.parentElement && element.parentElement.parentElement) {
        element.parentElement.parentElement.scrollTop = element.parentElement.parentElement.scrollHeight;
      }
    } else {
      clearInterval(timer);
      element.classList.remove('streaming');
      if (onComplete) onComplete();
    }
  }, delayMs);

  const cleanup = () => {
    clearInterval(timer);
    element.classList.remove('streaming');
    element.textContent = fullText;
  };
  activeStreamCleanups.push(cleanup);
  return cleanup;
}

/**
 * Re-render Translation Column in the newly selected targetLang
 */
function reRenderTranslationFeed() {
  clearActiveStreams();
  transFeed.innerHTML = '';
  if (recentFeedItems.length === 0) {
    transFeed.innerHTML = '<div class="idle-placeholder">Waiting for sermon to begin...</div>';
  } else {
    recentFeedItems.forEach((item, idx) => {
      const isCurrent = (idx === recentFeedItems.length - 1);
      const pTrans = document.createElement('div');
      pTrans.className = `para-item ${isCurrent ? 'current' : 'history'}`;
      let text = '';
      if (item.transObj && typeof item.transObj === 'object') {
        text = item.transObj[targetLang] || item.transObj.en || Object.values(item.transObj)[0] || '';
      } else {
        text = item.transObj || '';
      }
      pTrans.textContent = text;
      transFeed.appendChild(pTrans);
    });
    if (transFeed.parentElement) {
      transFeed.parentElement.scrollTo({ top: transFeed.parentElement.scrollHeight, behavior: 'smooth' });
    }
  }

  // Update active Ayah overlay if visible
  if (activeAyahData && ayahOverlay && ayahOverlay.classList.contains('active')) {
    let transText = '';
    if (activeAyahData.translations) {
      transText = activeAyahData.translations[targetLang] || activeAyahData.translations.en || Object.values(activeAyahData.translations)[0];
    } else if (activeAyahFallbackTrans) {
      if (typeof activeAyahFallbackTrans === 'object' && activeAyahFallbackTrans !== null) {
        transText = activeAyahFallbackTrans[targetLang] || activeAyahFallbackTrans.en || Object.values(activeAyahFallbackTrans)[0];
      } else {
        transText = activeAyahFallbackTrans;
      }
    }
    if (transText) {
      ayahTransEl.textContent = `"${transText}"`;
    }
  }
}

/**
 * Append New Sentence to Live Split Screen without Wiping History
 */
function appendToFeed(arabicText, transObj, isLive = true) {
  if (!arabicText && !transObj) return;

  // Track in recentFeedItems for re-rendering on language switch
  recentFeedItems.push({ arabicText, transObj });
  while (recentFeedItems.length > MAX_HISTORY) {
    recentFeedItems.shift();
  }

  // 1. Arabic Column
  if (arabicText) {
    const existingCurrent = arabicFeed.querySelectorAll('.para-item.current');
    existingCurrent.forEach(el => {
      el.classList.remove('current');
      el.classList.add('history');
    });

    const pArabic = document.createElement('div');
    pArabic.className = 'para-item current';
    arabicFeed.appendChild(pArabic);

    if (isLive) {
      streamWordsIntoElement(pArabic, arabicText, 70);
    } else {
      pArabic.textContent = arabicText;
    }

    while (arabicFeed.children.length > MAX_HISTORY) {
      arabicFeed.firstElementChild.remove();
    }
  }

  // 2. Translation Column
  let displayTrans = '';
  if (typeof transObj === 'object' && transObj !== null) {
    displayTrans = transObj[targetLang] || transObj.en || Object.values(transObj)[0] || '';
  } else {
    displayTrans = transObj || '';
  }

  if (displayTrans) {
    const existingTrans = transFeed.querySelectorAll('.para-item.current');
    existingTrans.forEach(el => {
      el.classList.remove('current');
      el.classList.add('history');
    });

    const pTrans = document.createElement('div');
    pTrans.className = 'para-item current';
    transFeed.appendChild(pTrans);

    if (isLive) {
      streamWordsIntoElement(pTrans, displayTrans, 75);
      if (isTvAudioEnabled) {
        playTvBrowserAudio(displayTrans, targetLang);
      }
    } else {
      pTrans.textContent = displayTrans;
    }

    while (transFeed.children.length > MAX_HISTORY) {
      transFeed.firstElementChild.remove();
    }
  }

  // Smooth auto-scroll
  setTimeout(() => {
    if (arabicFeed.parentElement) {
      arabicFeed.parentElement.scrollTo({ top: arabicFeed.parentElement.scrollHeight, behavior: 'smooth' });
    }
    if (transFeed.parentElement) {
      transFeed.parentElement.scrollTo({ top: transFeed.parentElement.scrollHeight, behavior: 'smooth' });
    }
  }, 50);
}

/**
 * Handle Incoming Transcript & Translation (Live Real-Time Stream)
 */
function handleIncomingSpeech({ arabic, translations, translated, ayah, timestamp }, isLive = true) {
  if (!arabic && !translated && !translations) return;

  let transObj = translations;
  if (!transObj && translated) {
    transObj = { [targetLang]: translated };
  }

  // Quran Ayah Overlay is DISABLED — just append to feeds directly
  appendToFeed(arabic, transObj, isLive);
}

/**
 * Quran Ayah Overlay — DISABLED (kept as no-op for compatibility)
 */
function showAyahOverlay() { /* disabled */ }
function hideAyahOverlay() { /* disabled */ }


/**
 * Initialize Session details & RESTORE HISTORY ON REFRESH
 */
async function initSession() {
  initQRCode();

  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.mosqueName) currentMosqueName = data.mosqueName;
      updateTVStatusUI(data.status, data.mosqueName);

      if (data.tvFontSize) {
        applyTvFontSize(data.tvFontSize, data.tvCapacity, false);
      }
      if (data.tvAudioEnabled !== undefined) {
        setTvAudioState(data.tvAudioEnabled);
      }
      if (data.tvShowQr !== undefined) {
        setTvQrVisibility(data.tvShowQr);
      }

      // Only adopt session primaryLanguage on initial load IF user has NOT explicitly chosen a language
      if (!userExplicitlySelectedLang && data.primaryLanguage && VALID_LANGS.includes(data.primaryLanguage)) {
        targetLang = data.primaryLanguage;
        if (targetLangSelect) targetLangSelect.value = targetLang;
        initQRCode();
      }

      // ─── RESTORE HISTORY ON PAGE REFRESH ───
      if (data.transcripts && data.transcripts.length > 0) {
        const recent = data.transcripts.slice(-MAX_HISTORY);
        arabicFeed.innerHTML = '';
        transFeed.innerHTML = '';
        recentFeedItems.length = 0;
        recent.forEach(item => {
          if (item.timestamp) seenTimestamps.add(item.timestamp);
          const transObj = item.translations || (typeof item.translated === 'string' ? { [targetLang]: item.translated } : item.translated);
          appendToFeed(item.arabic, transObj, false);
        });
      }
    }
  } catch (err) {}

  connectWebSocket();
  startFeedSync();
}

let tvHeartbeatInterval = null;
function startTvHeartbeat() {
  if (tvHeartbeatInterval) clearInterval(tvHeartbeatInterval);
  tvHeartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'HEARTBEAT',
        sessionId,
        role: 'tv',
        language: targetLang,
        clientId: tvClientId,
        deviceType: 'computer'
      }));
    }
    fetch(`/api/session/${sessionId}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: tvClientId,
        role: 'tv',
        language: targetLang,
        deviceType: 'computer'
      })
    }).catch(() => {});
  }, 10000);
}

/**
 * WebSocket Connection with auto-reconnect
 */
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'JOIN_ROOM',
      sessionId,
      role: 'tv',
      language: targetLang,
      clientId: tvClientId,
      deviceType: 'computer'
    }));
    startTvHeartbeat();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'SESSION_STATUS') {
        updateTVStatusUI(data.status, data.mosqueName);
      }
      if (data.type === 'JOINED_SUCCESS' && data.session) {
        if (data.session.tvFontSize) applyTvFontSize(data.session.tvFontSize, data.session.tvCapacity, false);
        if (data.session.tvAudioEnabled !== undefined) setTvAudioState(data.session.tvAudioEnabled);
        if (data.session.tvShowQr !== undefined) setTvQrVisibility(data.session.tvShowQr);
      }
      if (data.type === 'TV_SETTINGS_UPDATE') {
        if (data.tvFontSize) applyTvFontSize(data.tvFontSize, data.tvCapacity, true);
        if (data.tvAudioEnabled !== undefined) setTvAudioState(data.tvAudioEnabled);
        if (data.tvShowQr !== undefined) setTvQrVisibility(data.tvShowQr);
      }
      if (data.type === 'SESSION_CLEAR_TEXT') {
        clearTvFeeds();
      }
      if (data.type === 'SESSION_DELETED') {
        clearTvFeeds();
        if (stageStatusBanner && stageStatusText) {
          stageStatusText.textContent = 'Session has been concluded and removed';
          stageStatusBanner.style.display = 'block';
          stageStatusBanner.style.background = 'rgba(239, 68, 68, 0.25)';
          stageStatusBanner.style.color = '#fca5a5';
        }
      }
      if (data.type === 'LIVE_SUBTITLE') {
        // Mark this timestamp as seen so the HTTP fallback won't re-render it
        if (data.timestamp) seenTimestamps.add(data.timestamp);
        handleIncomingSpeech(data, true);
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2500);
  };
}

/**
 * HTTP Feed Polling Fallback
 */
function startFeedSync() {
  if (feedSyncInterval) clearInterval(feedSyncInterval);
  feedSyncInterval = setInterval(async () => {
    try {
      // Always fetch the last few transcripts to catch any missed items
      const url = `/api/session/${sessionId}/feed`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status) {
        updateTVStatusUI(data.status, data.mosqueName);
      }
      if (data.tvFontSize && data.tvFontSize !== currentTvFontSize) {
        applyTvFontSize(data.tvFontSize, data.tvCapacity, false);
      }
      if (data.tvAudioEnabled !== undefined && data.tvAudioEnabled !== isTvAudioEnabled) {
        setTvAudioState(data.tvAudioEnabled);
      }
      if (data.tvShowQr !== undefined && data.tvShowQr !== isTvQrVisible) {
        setTvQrVisibility(data.tvShowQr);
      }
      if (data.transcripts && data.transcripts.length === 0 && recentFeedItems.length > 0) {
        clearTvFeeds();
      }
      if (data.transcripts && data.transcripts.length > 0) {
        // Only process items we haven't seen yet (by timestamp)
        const newItems = data.transcripts.filter(item => item.timestamp && !seenTimestamps.has(item.timestamp));
        newItems.forEach(item => {
          seenTimestamps.add(item.timestamp);
          handleIncomingSpeech({
            arabic: item.arabic,
            translations: item.translations,
            translated: (item.translations && item.translations[targetLang]) || (item.translations && item.translations.en) || item.arabic,
            ayah: item.ayah,
            timestamp: item.timestamp
          }, true);
        });
        // Cap the Set size to avoid memory growth in long sessions
        if (seenTimestamps.size > 500) {
          const iter = seenTimestamps.values();
          for (let i = 0; i < 100; i++) seenTimestamps.delete(iter.next().value);
        }
      }
    } catch (e) {}
  }, 2000);
}

// Aliases for compatibility
function startDisplayFeedSync() { startFeedSync(); }
function renderSubtitle(data) { handleIncomingSpeech(data, true); }
function setTvLiveStatus(s, m) { updateTVStatusUI(s, m); }

function toggleFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    if (btn) btn.textContent = '⛶ Exit Fullscreen';
  } else {
    document.exitFullscreen();
    if (btn) btn.textContent = '⛶ Fullscreen';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSession);
} else {
  initSession();
}

