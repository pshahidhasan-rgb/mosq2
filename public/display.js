// MosqAI - Live TV Split-Screen Script (Enhanced with Dropdown, Safe QR & History Persistence)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'myo-youth';

let targetLang = urlParams.get('lang') || 'en';
let currentMosqueName = 'MYO YOUTH CENTER';
let ws = null;
let lastDisplayTimestamp = null;
let ayahTimer = null;

// History queues for Arabic and Translation
const MAX_HISTORY = 4;
const arabicHistory = [];
const transHistory = [];

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

// Initialize Dropdown Selection
if (targetLangSelect) {
  if (['en', 'uz', 'tr', 'ur', 'bn', 'fr', 'id', 'so'].includes(targetLang)) {
    targetLangSelect.value = targetLang;
  } else {
    targetLang = targetLangSelect.value;
  }

  targetLangSelect.addEventListener('change', () => {
    targetLang = targetLangSelect.value;
    initQRCode();
    renderFeed();
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
 * Render Split Screen Feed with Dimmed History & Live Word-by-Word Streaming
 */
function renderFeed(animateLatest = false) {
  if (arabicHistory.length === 0) return;

  clearActiveStreams();
  arabicFeed.innerHTML = '';
  transFeed.innerHTML = '';

  const totalArabic = arabicHistory.length;
  const totalTrans = transHistory.length;

  // Render Arabic Paragraphs
  arabicHistory.forEach((text, idx) => {
    const isLatest = idx === totalArabic - 1;
    const p = document.createElement('div');
    p.className = `para-item ${isLatest ? 'current' : 'history'}`;

    if (isLatest && animateLatest) {
      arabicFeed.appendChild(p);
      streamWordsIntoElement(p, text, 80);
    } else {
      p.textContent = text;
      arabicFeed.appendChild(p);
    }
  });

  // Render Translation Paragraphs
  transHistory.forEach((item, idx) => {
    const isLatest = idx === totalTrans - 1;
    const p = document.createElement('div');
    p.className = `para-item ${isLatest ? 'current' : 'history'}`;

    let displayTrans = '';
    if (typeof item === 'object' && item !== null) {
      displayTrans = item[targetLang] || item['en'] || Object.values(item)[0] || '';
    } else {
      displayTrans = item;
    }

    if (isLatest && animateLatest) {
      transFeed.appendChild(p);
      streamWordsIntoElement(p, displayTrans, 85);
    } else {
      p.textContent = displayTrans;
      transFeed.appendChild(p);
    }
  });

  arabicFeed.parentElement.scrollTop = arabicFeed.parentElement.scrollHeight;
  transFeed.parentElement.scrollTop = transFeed.parentElement.scrollHeight;
}

/**
 * Handle Incoming Transcript & Translation (Live Real-Time Stream)
 */
function handleIncomingSpeech({ arabic, translations, translated, ayah, timestamp }, isLive = true) {
  if (!arabic && !translated) return;

  // 1. Quran Ayah Overlay
  if (ayah) {
    showAyahOverlay(ayah, arabic, translations || translated, isLive);
  } else {
    hideAyahOverlay();
  }

  // 2. Append to History
  if (arabic) {
    if (arabicHistory.length === 0 || arabicHistory[arabicHistory.length - 1] !== arabic) {
      arabicHistory.push(arabic);
      if (arabicHistory.length > MAX_HISTORY) arabicHistory.shift();
    }
  }

  const transObj = translations || (typeof translated === 'string' ? { [targetLang]: translated } : translated);
  if (transObj) {
    transHistory.push(transObj);
    if (transHistory.length > MAX_HISTORY) transHistory.shift();
  }

  renderFeed(isLive);
}

/**
 * Quran Ayah Gold Fullscreen Overlay with word-by-word streaming
 */
function showAyahOverlay(ayah, fallbackArabic, fallbackTrans, isLive = true) {
  if (!ayahOverlay) return;
  const ref = ayah.reference || (ayah.surahNumber ? `Surah ${ayah.surahNameEnglish || ''} (${ayah.surahNumber}:${ayah.ayahNumber})` : 'Holy Quran');
  ayahRefEl.textContent = ref;
  ayahArabicEl.textContent = ayah.arabicUthmani || fallbackArabic || '';

  let transText = '';
  if (ayah.translations && ayah.translations[targetLang]) {
    transText = ayah.translations[targetLang];
  } else if (ayah.translations && ayah.translations['en']) {
    transText = ayah.translations['en'];
  } else if (ayah.translation) {
    transText = ayah.translation;
  } else if (typeof fallbackTrans === 'string') {
    transText = fallbackTrans;
  }

  ayahOverlay.classList.add('active');

  if (isLive) {
    streamWordsIntoElement(ayahTransEl, `"${transText}"`, 70);
  } else {
    ayahTransEl.textContent = `"${transText}"`;
  }

  clearTimeout(ayahTimer);
  ayahTimer = setTimeout(() => {
    hideAyahOverlay();
  }, 10000);
}

function hideAyahOverlay() {
  if (ayahOverlay && ayahOverlay.classList.contains('active')) {
    ayahOverlay.classList.remove('active');
  }
}

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

      if (data.primaryLanguage && targetLangSelect && !urlParams.has('lang')) {
        targetLang = data.primaryLanguage;
        targetLangSelect.value = targetLang;
        initQRCode();
      }

      // ─── RESTORE HISTORY ON PAGE REFRESH ───
      if (data.transcripts && data.transcripts.length > 0) {
        const recent = data.transcripts.slice(-MAX_HISTORY);
        arabicHistory.length = 0;
        transHistory.length = 0;
        recent.forEach(item => {
          if (item.arabic) arabicHistory.push(item.arabic);
          const transObj = item.translations || (typeof item.translated === 'string' ? { [targetLang]: item.translated } : item.translated);
          if (transObj) transHistory.push(transObj);
        });
        lastDisplayTimestamp = data.transcripts[data.transcripts.length - 1].timestamp;
        renderFeed(false);
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
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'JOIN_ROOM', sessionId, role: 'tv' }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'SESSION_STATUS') {
        updateTVStatusUI(data.status, data.mosqueName);
      }
      if (data.type === 'LIVE_SUBTITLE') {
        lastDisplayTimestamp = data.timestamp;
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
  setInterval(async () => {
    try {
      const url = `/api/session/${sessionId}/feed${lastDisplayTimestamp ? `?since=${encodeURIComponent(lastDisplayTimestamp)}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status) {
        updateTVStatusUI(data.status, data.mosqueName);
      }
      if (data.transcripts && data.transcripts.length > 0) {
        data.transcripts.forEach(item => {
          if (item.timestamp !== lastDisplayTimestamp) {
            lastDisplayTimestamp = item.timestamp;
            handleIncomingSpeech({
              arabic: item.arabic,
              translations: item.translations,
              translated: (item.translations && item.translations[targetLang]) || (item.translations && item.translations.en) || item.arabic,
              ayah: item.ayah,
              timestamp: item.timestamp
            }, true);
          }
        });
      }
    } catch (e) {}
  }, 2000);
}

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
