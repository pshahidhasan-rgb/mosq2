// MosqAI - Live TV Split-Screen Script (Matches Competitor TV Layout)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'jumuah-live';

const SUPPORTED_LANGS = [
  { code: 'en', name: 'English' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ur', name: 'Urdu' },
  { code: 'bn', name: 'Bengali' },
  { code: 'fr', name: 'French' }
];

let currentLangIndex = 0;
let targetLang = urlParams.get('lang') || SUPPORTED_LANGS[0].code;
const initialIdx = SUPPORTED_LANGS.findIndex(l => l.code === targetLang);
if (initialIdx !== -1) currentLangIndex = initialIdx;

let ws = null;
let lastDisplayTimestamp = null;
let ayahTimer = null;

// History queues for Arabic and Translation
const MAX_HISTORY = 4;
const arabicHistory = [];
const transHistory = [];

// DOM Elements
const mosqueNameEl = document.getElementById('mosque-name');
const targetLangLabel = document.getElementById('target-lang-label');
const pillTargetLang = document.getElementById('pill-target-lang');
const arabicFeed = document.getElementById('arabic-feed');
const transFeed = document.getElementById('trans-feed');
const qrImg = document.getElementById('qr-img');
const ayahOverlay = document.getElementById('ayah-overlay');
const ayahRefEl = document.getElementById('ayah-reference');
const ayahArabicEl = document.getElementById('ayah-arabic');
const ayahTransEl = document.getElementById('ayah-trans');

// Initialize Target Language Label
function updateLangUI() {
  const current = SUPPORTED_LANGS[currentLangIndex];
  targetLang = current.code;
  targetLangLabel.textContent = current.name;
}
updateLangUI();

// Allow TV operator to click and cycle target language
if (pillTargetLang) {
  pillTargetLang.addEventListener('click', () => {
    currentLangIndex = (currentLangIndex + 1) % SUPPORTED_LANGS.length;
    updateLangUI();
    // Re-render latest translated text with newly selected language if available
    renderFeed();
  });
}

/**
 * Generate QR code pointing to the real, current origin
 * Fixes localhost bug: will encode https://<deployed-url>/join.html
 */
function initQRCode() {
  const joinUrl = `${window.location.origin}/join.html?session=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(targetLang)}`;
  if (qrImg) {
    qrImg.src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
    qrImg.onerror = () => {
      // Fallback to third-party public QR generator if local generator is offline
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(joinUrl)}`;
    };
  }
}

/**
 * Render Split Screen Feed with Dimmed History & Bright Latest Sentence
 */
function renderFeed() {
  if (arabicHistory.length === 0) return;

  // Clear placeholders
  arabicFeed.innerHTML = '';
  transFeed.innerHTML = '';

  // Render Arabic Paragraphs
  arabicHistory.forEach((text, idx) => {
    const isLatest = idx === arabicHistory.length - 1;
    const p = document.createElement('div');
    p.className = `para-item ${isLatest ? 'current' : 'history'}`;
    p.textContent = text;
    arabicFeed.appendChild(p);
  });

  // Render Translation Paragraphs
  transHistory.forEach((item, idx) => {
    const isLatest = idx === transHistory.length - 1;
    const p = document.createElement('div');
    p.className = `para-item ${isLatest ? 'current' : 'history'}`;

    // Select text in current TV language, fallback to English, fallback to raw text
    let displayTrans = '';
    if (typeof item === 'object' && item !== null) {
      displayTrans = item[targetLang] || item['en'] || Object.values(item)[0] || '';
    } else {
      displayTrans = item;
    }

    p.textContent = displayTrans;
    transFeed.appendChild(p);
  });

  // Keep latest text in comfortable view
  arabicFeed.parentElement.scrollTop = arabicFeed.parentElement.scrollHeight;
  transFeed.parentElement.scrollTop = transFeed.parentElement.scrollHeight;
}

/**
 * Handle Incoming Transcript & Translation
 */
function handleIncomingSpeech({ arabic, translations, translated, ayah, timestamp }) {
  if (!arabic && !translated) return;

  // 1. Check for Quran Ayah Detection
  if (ayah) {
    showAyahOverlay(ayah, arabic, translations || translated);
  } else {
    hideAyahOverlay();
  }

  // 2. Append to History
  if (arabic) {
    // Avoid immediate duplicate
    if (arabicHistory.length === 0 || arabicHistory[arabicHistory.length - 1] !== arabic) {
      arabicHistory.push(arabic);
      if (arabicHistory.length > MAX_HISTORY) arabicHistory.shift();
    }
  }

  // Translations object or string
  const transObj = translations || (typeof translated === 'string' ? { [targetLang]: translated } : translated);
  if (transObj) {
    transHistory.push(transObj);
    if (transHistory.length > MAX_HISTORY) transHistory.shift();
  }

  renderFeed();
}

/**
 * Quran Ayah Gold Fullscreen Overlay
 */
function showAyahOverlay(ayah, fallbackArabic, fallbackTrans) {
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
  ayahTransEl.textContent = `"${transText}"`;

  ayahOverlay.classList.add('active');

  // Auto-hide after 10 seconds unless new speech arrives
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
 * Initialize Session details
 */
async function initSession() {
  initQRCode();

  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.mosqueName && mosqueNameEl) {
        mosqueNameEl.textContent = data.mosqueName;
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
      if (data.type === 'LIVE_SUBTITLE') {
        lastDisplayTimestamp = data.timestamp;
        handleIncomingSpeech(data);
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2500);
  };
}

/**
 * HTTP Feed Polling Fallback (ensures smooth real-time sync even through strict firewalls)
 */
function startFeedSync() {
  setInterval(async () => {
    try {
      const url = `/api/session/${sessionId}/feed${lastDisplayTimestamp ? `?since=${encodeURIComponent(lastDisplayTimestamp)}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
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
            });
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
