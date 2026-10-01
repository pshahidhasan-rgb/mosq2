// MosqAI - Attendee Mobile App Script (Direct Competitor Tarjam UI Match)
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || 'jumuah-live';
let currentLanguage = urlParams.get('lang') || 'en';

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
let isAudioEnabled = true;
let audioCtx = null;
const audioQueue = [];
let isPlayingAudio = false;
const renderedTimestamps = new Set();
let lastSyncTime = null;

// DOM Elements
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
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
    // If lang was explicitly passed in URL, jump directly to feed
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
      // Notify server of language change
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

// ─── AUDIO TOGGLE & SYNTHESIS ───
function toggleAudio() {
  isAudioEnabled = !isAudioEnabled;
  if (isAudioEnabled) {
    if (playPauseIcon) playPauseIcon.textContent = '⏸';
    if (audioFreqBars) audioFreqBars.classList.remove('idle');
    if (playerTitle) playerTitle.textContent = 'Translating live';
    if (playerSubtitle) playerSubtitle.textContent = `Streaming in ${getLangName(currentLanguage)}`;
    // Resume audio context
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } else {
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    if (audioFreqBars) audioFreqBars.classList.add('idle');
    if (playerTitle) playerTitle.textContent = 'Audio muted';
    if (playerSubtitle) playerSubtitle.textContent = 'Tap play to resume earbuds voice';
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
}

if (btnToggleAudio) btnToggleAudio.addEventListener('click', toggleAudio);

// ─── RENDERING COMPETITOR SERMON CARDS ───
function renderSermonCard({ arabic, translations, translated, ayah, timestamp }) {
  if (!arabic && !translated) return;

  // Resolve translation text for current language
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

  // Tag: Quran, Hadith, or Sermon
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

  // Insert before active listening card
  mobileCardsFeed.insertBefore(card, activeListeningCard);

  // Scroll to bottom
  mobileCardsFeed.scrollTop = mobileCardsFeed.scrollHeight;

  // Play audio if enabled
  if (isAudioEnabled && displayText) {
    speakSpeech(displayText, currentLanguage);
  }
}

// ─── AUDIO PLAYBACK (Cartesia or Web Speech Synthesis) ───
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
      if (data.mosqueName && s1MosqueName) {
        const parts = data.mosqueName.split(' ');
        s1MosqueName.innerHTML = `<span>${parts[0]}</span> ${parts.slice(1).join(' ')}`;
      }
    }
  } catch (err) {}
}
fetchMosqueDetails();

async function initLiveSession() {
  updateLangDisplay();
  await fetchMosqueDetails();
  connectWebSocket();
  startFeedSync();

  // Try to pre-warm audio context on user interaction
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch (e) {}
}

// If session or lang pre-set, automatically start
if (urlParams.has('session') && urlParams.has('lang')) {
  currentLanguage = urlParams.get('lang') || 'en';
  showStep(3);
  initLiveSession();
} else {
  showStep(1);
}
