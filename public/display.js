// MosqAI - Live TV Split-Screen Script (Enhanced with Dropdown, Safe QR & History Persistence)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'myo-youth';

const VALID_LANGS = ['en', 'uz', 'tr', 'ur', 'bn', 'fr', 'id', 'so', 'zh', 'zh-tw', 'de', 'es', 'ru'];
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
// Track timestamps rendered
const seenTimestamps = new Set();
let feedSyncInterval = null;

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
const sourceLangSelect = document.getElementById('source-lang-select');
const arabicCol = document.getElementById('arabic-col');
const arabicFeed = document.getElementById('arabic-feed');
const transFeed = document.getElementById('trans-feed');
const qrImg = document.getElementById('qr-img');
const ayahOverlay = document.getElementById('ayah-overlay');
const ayahRefEl = document.getElementById('ayah-reference');
const ayahArabicEl = document.getElementById('ayah-arabic');
const ayahTransEl = document.getElementById('ayah-trans');

// Source Language Selection (Left Column)
const VALID_SOURCE_LANGS = ['ar', 'ar-modern', 'en', 'zh', 'zh-tw', 'ur', 'tr', 'ms', 'id'];
let sourceLang = 'ar';
try {
  const savedSource = localStorage.getItem('mosq_tv_source_lang');
  if (savedSource && VALID_SOURCE_LANGS.includes(savedSource)) {
    sourceLang = savedSource;
  }
} catch (e) {}

function applySourceLanguage(lang) {
  if (!lang) return;
  sourceLang = lang;
  if (sourceLangSelect) sourceLangSelect.value = lang;
  try {
    localStorage.setItem('mosq_tv_source_lang', lang);
  } catch (e) {}

  const isRTL = ['ar', 'ar-modern', 'ur'].includes(lang);
  if (arabicCol) {
    arabicCol.style.direction = isRTL ? 'rtl' : 'ltr';
    arabicCol.style.textAlign = isRTL ? 'right' : 'left';
  }

  // Update idle placeholder text
  const placeholder = arabicFeed ? arabicFeed.querySelector('.idle-placeholder') : null;
  if (placeholder) {
    if (lang === 'zh' || lang === 'zh-tw') {
      placeholder.textContent = '等待演讲开始...';
    } else if (lang === 'en') {
      placeholder.textContent = 'Waiting for speech to begin...';
    } else if (lang === 'ur') {
      placeholder.textContent = 'خطبے کے آغاز کا انتظار ہے...';
    } else if (lang === 'tr') {
      placeholder.textContent = 'Hutbenin başlaması bekleniyor...';
    } else {
      placeholder.textContent = 'في انتظار بدء الخطبة...';
    }
  }

  reRenderSourceFeed();
}

if (sourceLangSelect) {
  sourceLangSelect.value = sourceLang;
  sourceLangSelect.addEventListener('change', () => {
    applySourceLanguage(sourceLangSelect.value);
  });
}

// Initialize Target Dropdown Selection & Change Handler (Right Column)
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

// Apply initial source language configuration
applySourceLanguage(sourceLang);

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
    qrImg.onerror = function() {
      this.onerror = null;
      this.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(joinUrl)}`;
    };
    qrImg.src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
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

function getSourceTextForFeed(arabicText, transObj) {
  if (sourceLang === 'ar' || sourceLang === 'ar-modern') {
    return arabicText || '';
  }
  if (transObj && typeof transObj === 'object') {
    if (sourceLang === 'zh-tw') {
      return transObj['zh-tw'] || transObj['zh'] || arabicText || '';
    }
    if (sourceLang === 'zh') {
      return transObj['zh'] || transObj['zh-tw'] || arabicText || '';
    }
    return transObj[sourceLang] || transObj['en'] || arabicText || '';
  }
  return arabicText || '';
}

function getTransTextForFeed(transObj) {
  if (!transObj) return '';
  if (typeof transObj === 'object') {
    if (targetLang === 'zh-tw') {
      return transObj['zh-tw'] || transObj['zh'] || transObj.en || Object.values(transObj)[0] || '';
    }
    if (targetLang === 'zh') {
      return transObj['zh'] || transObj['zh-tw'] || transObj.en || Object.values(transObj)[0] || '';
    }
    return transObj[targetLang] || transObj.en || Object.values(transObj)[0] || '';
  }
  return String(transObj);
}

/**
 * Re-render Source (Left) Column in the newly selected sourceLang
 */
function reRenderSourceFeed() {
  clearActiveStreams();
  arabicFeed.innerHTML = '';
  if (recentFeedItems.length === 0) {
    let placeholderText = 'في انتظار بدء الخطبة...';
    if (sourceLang === 'zh' || sourceLang === 'zh-tw') placeholderText = '等待演讲开始...';
    else if (sourceLang === 'en') placeholderText = 'Waiting for speech to begin...';
    else if (sourceLang === 'ur') placeholderText = 'خطبے کے آغاز کا انتظار ہے...';
    else if (sourceLang === 'tr') placeholderText = 'Hutbenin başlaması bekleniyor...';
    arabicFeed.innerHTML = `<div class="idle-placeholder">${placeholderText}</div>`;
  } else {
    recentFeedItems.forEach((item, idx) => {
      const isCurrent = (idx === recentFeedItems.length - 1);
      const pSource = document.createElement('div');
      pSource.className = `para-item ${isCurrent ? 'current' : 'history'}`;
      pSource.textContent = getSourceTextForFeed(item.arabicText, item.transObj);
      arabicFeed.appendChild(pSource);
    });
    if (arabicFeed.parentElement) {
      arabicFeed.parentElement.scrollTo({ top: arabicFeed.parentElement.scrollHeight, behavior: 'smooth' });
    }
  }
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
      pTrans.textContent = getTransTextForFeed(item.transObj);
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

  // 1. Source (Left) Column
  const sourceDisplayText = getSourceTextForFeed(arabicText, transObj);
  if (sourceDisplayText) {
    const existingCurrent = arabicFeed.querySelectorAll('.para-item.current');
    existingCurrent.forEach(el => {
      el.classList.remove('current');
      el.classList.add('history');
    });

    const pArabic = document.createElement('div');
    pArabic.className = 'para-item current';
    arabicFeed.appendChild(pArabic);

    if (isLive) {
      streamWordsIntoElement(pArabic, sourceDisplayText, 70);
    } else {
      pArabic.textContent = sourceDisplayText;
    }

    while (arabicFeed.children.length > MAX_HISTORY) {
      arabicFeed.firstElementChild.remove();
    }
  }

  // 2. Translation (Right) Column
  const displayTrans = getTransTextForFeed(transObj);
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
  }, 100);
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
    ws.send(JSON.stringify({ type: 'JOIN_ROOM', sessionId, role: 'tv', language: targetLang, deviceType: 'desktop' }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'SESSION_STATUS') {
        updateTVStatusUI(data.status, data.mosqueName);
      }
      if (data.type === 'JOINED_SUCCESS' && data.session && data.session.tvFontSize) {
        applyTvFontSize(data.session.tvFontSize, data.session.tvCapacity, false);
      }
      if (data.type === 'TV_SETTINGS_UPDATE') {
        applyTvFontSize(data.tvFontSize, data.tvCapacity, true);
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
      if (data.transcripts && data.transcripts.length > 0) {
        // Only process items we haven't seen yet (by timestamp)
        const newItems = data.transcripts.filter(item => item.timestamp && !seenTimestamps.has(item.timestamp));
        if (newItems.length > 0) {
          updateTVStatusUI('active', data.mosqueName); // Force active if new speech arrives
        }
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

