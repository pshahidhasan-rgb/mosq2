// MosqAI - Attendee Mobile App Script (Competitor Layout with History Persistence & Audio Off by Default)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'myo-youth';
let currentLanguage = urlParams.get('lang') || 'en';
let currentMosqueName = 'Live Sermon';

const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'uz', name: 'Uzbek', native: 'O‘zbekcha', flag: '🇺🇿' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', flag: '🇹🇷' },
  { code: 'ur', name: 'Urdu', native: 'اردو', flag: '🇵🇰' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', flag: '🇧🇩' },
  { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa', flag: '🇮🇩' },
  { code: 'so', name: 'Somali', native: 'Soomaali', flag: '🇸🇴' }
];

let ws = null;
let isAudioEnabled = false; // INITIALLY COMPLETELY OFF!
let audioCtx = null;
const audioQueue = [];
let isPlayingAudio = false;
const renderedTimestamps = new Set();
let lastSyncTime = null;

// DOM Elements
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const s1MosqueName = document.getElementById('s1-mosque-name');
const btnJoin = document.getElementById('btn-join');
const btnConfirmLang = document.getElementById('btn-confirm-lang');
const btnBack = document.getElementById('btn-back');
const btnOpenLangModal = document.getElementById('btn-open-lang-modal');
const langModal = document.getElementById('lang-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const modalLangGrid = document.getElementById('modal-lang-grid');
const currentLangNameEl = document.getElementById('current-lang-name');
const mobileCardsFeed = document.getElementById('mobile-cards-feed');
const activeListeningCard = document.getElementById('active-listening-card');
const compLiveBadge = document.querySelector('.comp-live-badge');
const mobileSessionBanner = document.getElementById('mobile-session-banner');
const mobileSessionBannerText = document.getElementById('mobile-session-banner-text');

// Audio elements
const btnToggleAudio = document.getElementById('btn-toggle-audio');
const playPauseIcon = document.getElementById('play-pause-icon');
const audioFreqBars = document.getElementById('audio-freq-bars');
const playerTitle = document.getElementById('player-title');
const playerSubtitle = document.getElementById('player-subtitle');

function getLangName(code) {
  const item = LANGUAGES.find(l => l.code === code);
  return item ? item.name : code.toUpperCase();
}

function updateLangDisplay() {
  if (currentLangNameEl) currentLangNameEl.textContent = getLangName(currentLanguage);
  if (playerSubtitle && isAudioEnabled) {
    playerSubtitle.textContent = `Streaming in ${getLangName(currentLanguage)}`;
  }
}

function updateMobileStatus(status, mosqueName) {
  if (mosqueName) currentMosqueName = mosqueName;

  if (status === 'active') {
    if (compLiveBadge) {
      compLiveBadge.innerHTML = '<div class="pulsing-dot"></div> LIVE';
      compLiveBadge.style.cssText = 'background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399;';
    }
    if (mobileSessionBanner) {
      mobileSessionBanner.style.display = 'block';
      mobileSessionBanner.style.background = 'rgba(16, 185, 129, 0.15)';
      mobileSessionBanner.style.color = '#34d399';
      mobileSessionBannerText.textContent = `${currentMosqueName} — LIVE`;
    }
  } else if (status === 'paused') {
    if (compLiveBadge) {
      compLiveBadge.innerHTML = '⏸ PAUSED';
      compLiveBadge.style.cssText = 'background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24;';
    }
    if (mobileSessionBanner) {
      mobileSessionBanner.style.display = 'block';
      mobileSessionBanner.style.background = 'rgba(245, 158, 11, 0.2)';
      mobileSessionBanner.style.color = '#fde68a';
      mobileSessionBannerText.textContent = `${currentMosqueName} — Live Translation Paused`;
    }
  } else if (status === 'ended') {
    if (compLiveBadge) {
      compLiveBadge.innerHTML = '⏹ ENDED';
      compLiveBadge.style.cssText = 'background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;';
    }
    if (mobileSessionBanner) {
      mobileSessionBanner.style.display = 'block';
      mobileSessionBanner.style.background = 'rgba(239, 68, 68, 0.2)';
      mobileSessionBanner.style.color = '#fca5a5';
      mobileSessionBannerText.textContent = `${currentMosqueName} — Session Ended`;
    }
  }
}

// ─── STEP NAVIGATION ───
function showStep(num) {
  step1.classList.remove('active');
  step2.classList.remove('active');
  step3.classList.remove('active');

  const target = document.getElementById(`step${num}`);
  if (target) target.classList.add('active');
}

// Step 1: Join Click
if (btnJoin) {
  btnJoin.addEventListener('click', () => {
    if (urlParams.has('lang')) {
      showStep(3);
      initLiveSession();
    } else {
      showStep(2);
    }
  });
}

// Step 2: Language Card Selection
let tempSelectedLang = currentLanguage;
document.querySelectorAll('#step2-lang-grid .lang-card-item').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('#step2-lang-grid .lang-card-item').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    tempSelectedLang = card.dataset.lang;
    btnConfirmLang.disabled = false;
  });
});

if (btnConfirmLang) {
  btnConfirmLang.addEventListener('click', () => {
    currentLanguage = tempSelectedLang;
    updateLangDisplay();
    showStep(3);
    initLiveSession();
  });
}

// Back Button in Step 3
if (btnBack) {
  btnBack.addEventListener('click', () => {
    openLangModal();
  });
}

// ─── IN-STREAM LANGUAGE MODAL ───
function renderModalLangs() {
  if (!modalLangGrid) return;
  modalLangGrid.innerHTML = '';
  LANGUAGES.forEach(l => {
    const card = document.createElement('div');
    card.className = `lang-card-item ${l.code === currentLanguage ? 'selected' : ''}`;
    card.innerHTML = `
      <div class="lang-flag">${l.flag}</div>
      <div class="lang-title">${l.name}</div>
      <div class="lang-sub">${l.native}</div>
    `;
    card.addEventListener('click', () => {
      currentLanguage = l.code;
      updateLangDisplay();
      closeLangModal();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'JOIN_ROOM',
          sessionId,
          role: 'attendee',
          language: currentLanguage
        }));
      }
    });
    modalLangGrid.appendChild(card);
  });
}

function openLangModal() {
  renderModalLangs();
  langModal.classList.add('open');
}

function closeLangModal() {
  langModal.classList.remove('open');
}

if (btnOpenLangModal) btnOpenLangModal.addEventListener('click', openLangModal);
if (btnCloseModal) btnCloseModal.addEventListener('click', closeLangModal);
if (langModal) {
  langModal.addEventListener('click', (e) => {
    if (e.target === langModal) closeLangModal();
  });
}

// ─── AUDIO TOGGLE & SYNTHESIS (Off by default, Turn on when clicked) ───
async function toggleAudio() {
  isAudioEnabled = !isAudioEnabled;
  if (isAudioEnabled) {
    if (playPauseIcon) playPauseIcon.textContent = '⏸';
    if (audioFreqBars) audioFreqBars.classList.remove('idle');
    if (playerTitle) playerTitle.textContent = 'Translating live';
    if (playerSubtitle) playerSubtitle.textContent = `Streaming in ${getLangName(currentLanguage)}`;

    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    } catch (e) {}
  } else {
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    if (audioFreqBars) audioFreqBars.classList.add('idle');
    if (playerTitle) playerTitle.textContent = 'Audio off';
    if (playerSubtitle) playerSubtitle.textContent = 'Tap play to stream audio to earbuds';
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
}

if (btnToggleAudio) btnToggleAudio.addEventListener('click', toggleAudio);

// ─── RENDERING SERMON CARDS ───
function renderSermonCard({ arabic, translations, translated, ayah, timestamp }) {
  if (!arabic && !translated) return;

  let displayText = '';
  if (ayah) {
    displayText = (ayah.translations && (ayah.translations[currentLanguage] || ayah.translations['en'])) ||
                  ayah.translation || translated || '';
  } else if (translations && typeof translations === 'object') {
    displayText = translations[currentLanguage] || translations['en'] || Object.values(translations)[0] || translated || '';
  } else {
    displayText = translated || '';
  }

  const card = document.createElement('div');
  card.className = 'sermon-card';

  let tagHtml = '';
  if (ayah) {
    const ref = ayah.reference || `Quran ${ayah.surahNumber || ''}:${ayah.ayahNumber || ''}`;
    tagHtml = `<span class="card-tag-pill quran">📖 ${ref}</span>`;
  } else if (arabic && (arabic.includes('قال رسول الله') || arabic.includes('صلى الله عليه وسلم'))) {
    tagHtml = `<span class="card-tag-pill">Aa HADITH</span>`;
  } else {
    tagHtml = `<span class="card-tag-pill">Aa SERMON</span>`;
  }

  card.innerHTML = `
    <div class="card-brand-glyph">T</div>
    <div class="card-translated-text">${displayText}</div>
    ${arabic ? `<div class="card-arabic-text" dir="rtl">${ayah && ayah.arabicUthmani ? ayah.arabicUthmani : arabic}</div>` : ''}
    ${tagHtml}
  `;

  mobileCardsFeed.insertBefore(card, activeListeningCard);
  mobileCardsFeed.scrollTop = mobileCardsFeed.scrollHeight;

  // Speak only if user explicitly turned audio on
  if (isAudioEnabled && displayText) {
    speakSpeech(displayText, currentLanguage);
  }
}

function speakSpeech(text, lang) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang || 'en';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (err) {}
}

// ─── WEBSOCKET & SYNC ───
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'JOIN_ROOM',
      sessionId,
      role: 'attendee',
      language: currentLanguage
    }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'SESSION_STATUS') {
        updateMobileStatus(data.status, data.mosqueName);
      }
      if (data.type === 'LIVE_SUBTITLE') {
        const key = data.timestamp || `${data.arabic}_${Date.now()}`;
        if (!renderedTimestamps.has(key)) {
          renderedTimestamps.add(key);
          renderSermonCard(data);
        }
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2500);
  };
}

function startFeedSync() {
  setInterval(async () => {
    try {
      const url = `/api/session/${sessionId}/feed${lastSyncTime ? `?since=${encodeURIComponent(lastSyncTime)}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status) {
        updateMobileStatus(data.status, data.mosqueName);
      }
      if (data.serverTime) lastSyncTime = data.serverTime;
      if (data.transcripts && data.transcripts.length > 0) {
        data.transcripts.forEach(item => {
          if (!renderedTimestamps.has(item.timestamp)) {
            renderedTimestamps.add(item.timestamp);
            renderSermonCard({
              arabic: item.arabic,
              translations: item.translations,
              translated: (item.translations && item.translations[currentLanguage]) || (item.translations && item.translations.en) || item.arabic,
              ayah: item.ayah,
              timestamp: item.timestamp
            });
          }
        });
      }
    } catch (e) {}
  }, 2000);
}

async function fetchMosqueDetails() {
  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.mosqueName) {
        currentMosqueName = data.mosqueName;
        if (s1MosqueName) {
          const parts = data.mosqueName.split(' ');
          s1MosqueName.innerHTML = `<span>${parts[0]}</span> ${parts.slice(1).join(' ')}`;
        }
      }
      if (data.status) {
        updateMobileStatus(data.status, data.mosqueName);
      }
      return data;
    }
  } catch (err) {}
  return null;
}
fetchMosqueDetails();

async function initLiveSession() {
  updateLangDisplay();
  const sessionData = await fetchMosqueDetails();

  // ─── RESTORE PREVIOUS CARDS ON PAGE REFRESH ───
  if (sessionData && sessionData.transcripts && sessionData.transcripts.length > 0) {
    sessionData.transcripts.forEach(item => {
      if (!renderedTimestamps.has(item.timestamp)) {
        renderedTimestamps.add(item.timestamp);
        renderSermonCard({
          arabic: item.arabic,
          translations: item.translations,
          translated: (item.translations && item.translations[currentLanguage]) || (item.translations && item.translations.en) || item.arabic,
          ayah: item.ayah,
          timestamp: item.timestamp
        });
      }
    });
  }

  connectWebSocket();
  startFeedSync();
}

// Auto-start if session and lang in URL
if (urlParams.has('session') && urlParams.has('lang')) {
  currentLanguage = urlParams.get('lang') || 'en';
  showStep(3);
  initLiveSession();
} else {
  showStep(1);
}
