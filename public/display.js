// MosqAI - Live TV Split-Screen Script (Enhanced with Dropdown, Safe QR & History Persistence)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'myo-youth';

const VALID_LANGS = ['en', 'uz', 'tr', 'ur', 'bn', 'fr', 'id', 'so'];
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

// History queue for re-rendering when user switches language
const MAX_HISTORY = 4;
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
    ws.send(JSON.stringify({ type: 'JOIN_ROOM', sessionId, role: 'tv', language: targetLang }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'SESSION_STATUS') {
        updateTVStatusUI(data.status, data.mosqueName);
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

