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

// BCP-47 language tag mappings for supported languages
const LANG_BCP47_MAP = {
  en: 'en-US',
  uz: 'uz-UZ',
  tr: 'tr-TR',
  ur: 'ur-PK',
  bn: 'bn-BD',
  fr: 'fr-FR',
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

function detectDeviceType() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile/i.test(ua)
    || (window.innerWidth <= 800 && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window));
  return isMobile ? 'phone' : 'computer';
}

function getClientId() {
  let cid = '';
  try {
    cid = localStorage.getItem('mosq_client_id');
    if (!cid) {
      cid = 'att_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
      localStorage.setItem('mosq_client_id', cid);
    }
  } catch (e) {
    cid = 'att_' + Math.random().toString(36).substring(2, 9);
  }
  return cid;
}

const myClientId = getClientId();
const myDeviceType = detectDeviceType();

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
function speakLatestCardIfAvailable() {
  if (!isAudioEnabled) return;
  const cards = mobileCardsFeed ? mobileCardsFeed.querySelectorAll('.sermon-card') : [];
  if (cards.length > 0) {
    const lastCard = cards[cards.length - 1];
    const textEl = lastCard.querySelector('.card-translated-text') || lastCard.querySelector('.card-text');
    if (textEl && textEl.textContent && textEl.textContent.trim()) {
      speakSpeech(textEl.textContent.trim(), currentLanguage);
    }
  }
}

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

    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
        const warmUp = new SpeechSynthesisUtterance('');
        warmUp.volume = 0;
        window.speechSynthesis.speak(warmUp);
      }
    } catch (e) {}

    speakLatestCardIfAvailable();
  } else {
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    if (audioFreqBars) audioFreqBars.classList.add('idle');
    if (playerTitle) playerTitle.textContent = 'Audio off';
    if (playerSubtitle) playerSubtitle.textContent = 'Tap play to stream audio to earbuds';
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
}

if (btnToggleAudio) {
  btnToggleAudio.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAudio();
  });
}
const compPlayerBar = document.querySelector('.comp-player-bar');
if (compPlayerBar) {
  compPlayerBar.addEventListener('click', (e) => {
    if (e.target.closest('#btn-toggle-audio')) return;
    toggleAudio();
  });
}

let activeMobileStreamCleanups = [];

function clearActiveMobileStreams() {
  activeMobileStreamCleanups.forEach(fn => {
    try { fn(); } catch (e) {}
  });
  activeMobileStreamCleanups = [];
}

function streamWordsToMobileCard(element, fullText, delayMs = 85, onComplete = null) {
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
      if (mobileCardsFeed) {
        mobileCardsFeed.scrollTop = mobileCardsFeed.scrollHeight;
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
  activeMobileStreamCleanups.push(cleanup);
  return cleanup;
}

// ─── RENDERING SERMON CARDS (Word-by-Word Live Streaming) ───
function renderSermonCard({ arabic, translations, translated, ayah, timestamp }, isLive = false) {
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
    <div class="card-brand-glyph">🎙️</div>
    <div class="card-translated-text"></div>
    ${arabic ? `<div class="card-arabic-text" dir="rtl">${ayah && ayah.arabicUthmani ? ayah.arabicUthmani : arabic}</div>` : ''}
    ${tagHtml}
  `;

  const transContainer = card.querySelector('.card-translated-text');
  if (isLive && displayText) {
    streamWordsToMobileCard(transContainer, displayText, 85);
  } else {
    transContainer.textContent = displayText;
  }

  mobileCardsFeed.insertBefore(card, activeListeningCard);
  mobileCardsFeed.scrollTop = mobileCardsFeed.scrollHeight;

  // Speak only if user explicitly turned audio on
  if (isAudioEnabled && displayText) {
    speakSpeech(displayText, currentLanguage);
  }
}

function speakSpeech(text, lang) {
  if (!isAudioEnabled) return;
  if (!('speechSynthesis' in window)) return;
  if (!text || typeof text !== 'string') return;
  const cleanText = text.trim();
  if (!cleanText) return;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    const bcpTag = LANG_BCP47_MAP[lang] || lang || 'en-US';
    utterance.lang = bcpTag;

    const maleVoice = getBestMaleVoice(lang);
    if (maleVoice) {
      utterance.voice = maleVoice;
    }
    utterance.pitch = 0.92;
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.warn('[Mobile Audio] Speech error:', err);
  }
}

// ─── WEBSOCKET & SYNC ───
let heartbeatInterval = null;
function startAttendeeHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'HEARTBEAT',
        sessionId,
        role: 'attendee',
        language: currentLanguage,
        clientId: myClientId,
        deviceType: myDeviceType
      }));
    }
    // Also ping HTTP endpoint to guarantee attendance count on all network types
    fetch(`/api/session/${sessionId}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: myClientId,
        role: 'attendee',
        language: currentLanguage,
        deviceType: myDeviceType
      })
    }).catch(() => {});
  }, 10000);
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'JOIN_ROOM',
      sessionId,
      role: 'attendee',
      language: currentLanguage,
      clientId: myClientId,
      deviceType: myDeviceType
    }));
    startAttendeeHeartbeat();
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
          renderSermonCard(data, true);
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
            }, true);
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
