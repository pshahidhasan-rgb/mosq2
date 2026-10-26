// MosqAI — Attendee Mobile App
// Continuous manuscript view · persistent history · first-sentence-reliable audio
'use strict';

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
  { code: 'zh', name: 'Chinese (Mandarin)', native: '中文 (普通话)', flag: '🇨🇳' },
  { code: 'zh-TW', name: 'Traditional Chinese', native: '中文 (繁體)', flag: '🇹🇼' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa', flag: '🇮🇩' },
  { code: 'so', name: 'Somali', native: 'Soomaali', flag: '🇸🇴' }
];
const RTL_LANGS = new Set(['ur', 'ar']);

const LANG_BCP47_MAP = {
  en: 'en-US', uz: 'uz-UZ', tr: 'tr-TR', ur: 'ur-PK', bn: 'bn-BD', fr: 'fr-FR',
  zh: 'zh-CN', 'zh-TW': 'zh-TW', id: 'id-ID', so: 'so-SO', ar: 'ar-SA'
};
const MALE_VOICE_KEYWORDS = ['male','david','mark','george','guy','paul','daniel','thomas','alex','fred','oliver','arthur','aaron','james','nathan','rishi','tarik','mehdi','salman','ali','hakan','berk','cem','deep','baritone'];
const FEMALE_VOICE_KEYWORDS = ['female','zira','susan','samantha','victoria','karen','moira','fiona','tessa','veena','yelda','filiz','amira','zeina','salma','camille','clara','marie','anna','helena','eva','laura','lucia'];

// Paragraph grouping (manuscript feel)
const SENTENCES_PER_PARAGRAPH = 4;
const PARAGRAPH_PAUSE_MS = 6000;

// ═════════════════════════════════════════════
// STATE — Single Source of Truth
// ═════════════════════════════════════════════
const segments = new Map();      // key -> { key, translations:{}, text, arabic, ayah, ts, order }
const keyAlias = new Map();      // alternate key (timestamp) -> canonical key
let segmentOrder = 0;
let liveText = '';               // current provisional hypothesis (current language)
let lastSyncTime = null;

let ws = null;

// DOM Helpers
const $ = (id) => document.getElementById(id);
const step1 = $('step1'), step2 = $('step2'), step3 = $('step3');
const s1MosqueName = $('s1-mosque-name');
const btnJoin = $('btn-join');
const btnConfirmLang = $('btn-confirm-lang');
const btnBack = $('btn-back');
const btnOpenLangModal = $('btn-open-lang-modal');
const langModal = $('lang-modal');
const btnCloseModal = $('btn-close-modal');
const modalLangGrid = $('modal-lang-grid');
const currentLangNameEl = $('current-lang-name');
const feedEl = $('manuscript-feed');
const historyEl = $('manuscript-history');
const currentEl = $('manuscript-current');
const listeningEl = $('listening-indicator');
const jumpLatestBtn = $('jump-latest');
const compLiveBadge = document.querySelector('.comp-live-badge');
const mobileSessionBanner = $('mobile-session-banner');
const mobileSessionBannerText = $('mobile-session-banner-text');
const btnToggleAudio = $('btn-toggle-audio');
const playPauseIcon = $('play-pause-icon');
const audioFreqBars = $('audio-freq-bars');
const playerTitle = $('player-title');
const playerSubtitle = $('player-subtitle');

// ═════════════════════════════════════════════
// IDENTITY & DEVICE HELPERS
// ═════════════════════════════════════════════
function detectDeviceType() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)
    || (window.innerWidth <= 800 && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window));
  return isMobile ? 'phone' : 'computer';
}

function getClientId() {
  try {
    let cid = localStorage.getItem('mosq_client_id');
    if (!cid) {
      cid = 'att_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
      localStorage.setItem('mosq_client_id', cid);
    }
    return cid;
  } catch (e) {
    return 'att_' + Math.random().toString(36).slice(2, 9);
  }
}
const myClientId = getClientId();
const myDeviceType = detectDeviceType();

function getLangName(code) {
  const item = LANGUAGES.find(l => l.code === code);
  return item ? item.name : (code ? code.toUpperCase() : 'English');
}

function updateLangDisplay() {
  if (currentLangNameEl) currentLangNameEl.textContent = getLangName(currentLanguage);
  if (playerSubtitle && isAudioEnabled) {
    playerSubtitle.textContent = `Streaming in ${getLangName(currentLanguage)}`;
  }
}

// ═════════════════════════════════════════════
// KEYS & DEDUPLICATION
// ═════════════════════════════════════════════
function segKey(obj) {
  if (!obj) return null;
  if (obj.seq !== undefined && obj.seq !== null) return `seq_${obj.seq}`;
  if (obj.timestamp) return `ts_${obj.timestamp}`;
  return null;
}

function registerAlias(key, obj) {
  if (obj && obj.timestamp) keyAlias.set(`ts_${obj.timestamp}`, key);
  if (obj && obj.seq) keyAlias.set(`seq_${obj.seq}`, key);
}

// ═════════════════════════════════════════════
// TEXT EXTRACTION
// ═════════════════════════════════════════════
function pickText(item, lang) {
  if (!item) return '';
  if (item.ayah) {
    if (item.ayah.translations && (item.ayah.translations[lang] || item.ayah.translations.en)) {
      return item.ayah.translations[lang] || item.ayah.translations.en;
    }
    if (item.ayah.translation) return item.ayah.translation;
  }
  if (item.translations && typeof item.translations === 'object') {
    return item.translations[lang] || item.translations.en || Object.values(item.translations)[0] || '';
  }
  return item.translated || item.text || item.arabic || '';
}

// ═════════════════════════════════════════════
// MANUSCRIPT RENDERING (Continuous Flow)
// ═════════════════════════════════════════════
function renderManuscript() {
  if (!historyEl) return;
  historyEl.innerHTML = '';

  const sorted = Array.from(segments.values()).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (sorted.length === 0) {
    return;
  }

  let currentP = null;
  let sentenceCount = 0;
  let lastTime = null;

  sorted.forEach((seg) => {
    const text = pickText(seg, currentLanguage).trim();
    if (!text) return;

    const segTime = seg.ts ? new Date(seg.ts).getTime() : 0;
    const isNewParagraph = (sentenceCount >= SENTENCES_PER_PARAGRAPH) || 
                          (lastTime && segTime && (segTime - lastTime > PARAGRAPH_PAUSE_MS));

    if (!currentP || isNewParagraph) {
      currentP = document.createElement('p');
      currentP.className = `para-item history ${RTL_LANGS.has(currentLanguage) ? 'rtl' : ''}`;
      historyEl.appendChild(currentP);
      sentenceCount = 0;
    }

    const span = document.createElement('span');
    span.className = 'sent';
    span.textContent = (sentenceCount === 0 ? '' : ' ') + text;
    currentP.appendChild(span);

    sentenceCount++;
    lastTime = segTime;
  });

  scrollFeedToBottom();
}

function updateLiveStreamView() {
  if (!currentEl) return;
  if (!liveText || !liveText.trim()) {
    currentEl.textContent = '';
    currentEl.classList.remove('streaming');
    return;
  }
  currentEl.className = `para-item current streaming ${RTL_LANGS.has(currentLanguage) ? 'rtl' : ''}`;
  currentEl.textContent = liveText.trim();
  scrollFeedToBottom();
}

function scrollFeedToBottom(force = false) {
  if (!feedEl) return;
  const isNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 140;
  if (force || isNearBottom) {
    feedEl.scrollTo({ top: feedEl.scrollHeight, behavior: 'smooth' });
    if (jumpLatestBtn) jumpLatestBtn.style.display = 'none';
  } else {
    if (jumpLatestBtn) jumpLatestBtn.style.display = 'block';
  }
}

if (jumpLatestBtn) {
  jumpLatestBtn.addEventListener('click', () => {
    scrollFeedToBottom(true);
  });
}

if (feedEl) {
  feedEl.addEventListener('scroll', () => {
    const isNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 140;
    if (jumpLatestBtn) {
      jumpLatestBtn.style.display = isNearBottom ? 'none' : 'block';
    }
  });
}

// ═════════════════════════════════════════════
// AUDIO SYNTHESIS & ROBUST QUEUE
// ═════════════════════════════════════════════
let isAudioEnabled = false;
let audioCtx = null;
const audioQueue = [];
let isPlayingAudio = false;
const spokenKeys = new Set();
let cachedVoices = [];

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  try {
    cachedVoices = window.speechSynthesis.getVoices() || [];
  } catch (_) {}
}
if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function getBestVoice(langCode) {
  if (!cachedVoices.length) loadVoices();
  const targetPrefix = (langCode || 'en').toLowerCase().split('-')[0];
  const matching = cachedVoices.filter(v => (v.lang || '').toLowerCase().replace('_', '-').startsWith(targetPrefix));
  const pool = matching.length ? matching : cachedVoices;

  for (const voice of pool) {
    const nameLower = voice.name.toLowerCase();
    const isMale = MALE_VOICE_KEYWORDS.some(kw => nameLower.includes(kw));
    const isFemale = FEMALE_VOICE_KEYWORDS.some(kw => nameLower.includes(kw));
    if (isMale && !isFemale) return voice;
  }
  return pool[0] || null;
}

function enqueueSpeech(text, lang, key = null) {
  if (!isAudioEnabled) return;
  if (key && spokenKeys.has(key)) return;
  if (key) spokenKeys.add(key);

  const clean = (text || '').trim();
  if (!clean) return;

  audioQueue.push({ text: clean, lang: lang || currentLanguage });
  processAudioQueue();
}

function processAudioQueue() {
  if (isPlayingAudio || audioQueue.length === 0 || !isAudioEnabled) return;
  if (!('speechSynthesis' in window)) return;

  const item = audioQueue.shift();
  isPlayingAudio = true;

  try {
    window.speechSynthesis.resume();
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = LANG_BCP47_MAP[item.lang] || item.lang || 'en-US';
    const voice = getBestVoice(item.lang);
    if (voice) utterance.voice = voice;
    utterance.rate = 1.0;
    utterance.pitch = 0.95;

    // Chrome 12-second speech synthesis stall watchdog
    const watchdog = setTimeout(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 12000);

    const onFinish = () => {
      clearTimeout(watchdog);
      isPlayingAudio = false;
      processAudioQueue();
    };

    utterance.onend = onFinish;
    utterance.onerror = onFinish;

    window.speechSynthesis.speak(utterance);
  } catch (err) {
    isPlayingAudio = false;
    processAudioQueue();
  }
}

async function toggleAudio() {
  isAudioEnabled = !isAudioEnabled;

  if (isAudioEnabled) {
    if (playPauseIcon) playPauseIcon.textContent = '⏸';
    if (audioFreqBars) audioFreqBars.classList.remove('idle');
    if (playerTitle) playerTitle.textContent = 'Translating live';
    if (playerSubtitle) playerSubtitle.textContent = `Streaming in ${getLangName(currentLanguage)}`;

    // 1. Synchronously prime SpeechSynthesis inside the tap gesture
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
        const prime = new SpeechSynthesisUtterance(' ');
        prime.volume = 0.01;
        window.speechSynthesis.speak(prime);
      }
    } catch (_) {}

    // 2. Resume AudioContext if suspended
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    } catch (_) {}

    // 3. Play latest finalized sentence if available
    const sorted = Array.from(segments.values()).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (sorted.length > 0) {
      const lastSeg = sorted[sorted.length - 1];
      const text = pickText(lastSeg, currentLanguage);
      if (text) enqueueSpeech(text, currentLanguage, lastSeg.key);
    }
  } else {
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    if (audioFreqBars) audioFreqBars.classList.add('idle');
    if (playerTitle) playerTitle.textContent = 'Audio off';
    if (playerSubtitle) playerSubtitle.textContent = 'Tap play to stream audio to earbuds';
    audioQueue.length = 0;
    isPlayingAudio = false;
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

// ═════════════════════════════════════════════
// SENTENCE COMMIT & STREAMING INGEST
// ═════════════════════════════════════════════

/**
 * Commit a finalized sentence into the segments map.
 * The server sends attendees: { translatedFull, translatedChunk, isReplacement, isFinal, lang, seq, timestamp }
 * It does NOT send data.translations or data.translated — so we build the translations map from translatedFull.
 */
function commitSentence(data) {
  // Resolve the finalized text — prefer translatedFull (set by server on isFinal),
  // then fall back to translated, then liveText (which was built from streaming chunks)
  const finalText = (data.translatedFull || '').trim()
    || (data.translated || '').trim()
    || liveText.trim();

  if (!finalText) {
    // Nothing to commit; just clear the live stream indicator
    liveText = '';
    updateLiveStreamView();
    return;
  }

  const key = segKey(data) || `gen_${Date.now()}_${++segmentOrder}`;
  registerAlias(key, data);

  // Build translations from the data we have:
  // 1. If the server sent a full translations object, use it.
  // 2. Otherwise build one from translatedFull / translated.
  const translations =
    (data.translations && Object.keys(data.translations).length > 0)
      ? data.translations
      : { [currentLanguage]: finalText };

  segments.set(key, {
    key,
    translations,
    arabic: data.arabic || '',
    ayah: data.ayah || null,
    ts: data.timestamp || new Date().toISOString(),
    order: ++segmentOrder
  });

  liveText = '';
  updateLiveStreamView();
  renderManuscript();

  if (isAudioEnabled && finalText) {
    enqueueSpeech(finalText, currentLanguage, key);
  }
}

/**
 * Handle sub-200ms word-by-word streaming tokens from the server.
 * Server payload for attendees: { type, lang, translatedChunk, translatedFull, isReplacement, isFinal, seq, timestamp }
 */
function handleStreamingTokenMobile(data) {
  // Server only sends tokens for our language (filtered server-side), but guard anyway
  if (data.lang && data.lang !== currentLanguage) return;

  if (data.isFinal) {
    // On final, the server sets translatedFull to the complete sentence text.
    // If translatedFull is empty (translation still processing), use accumulated liveText.
    if (!data.translatedFull && liveText) {
      data = Object.assign({}, data, { translatedFull: liveText });
    }
    commitSentence(data);
    return;
  }

  // Accumulate streaming chunks into liveText for real-time display
  if (data.isReplacement) {
    liveText = data.translatedFull || data.translatedChunk || '';
  } else {
    liveText = liveText + (data.translatedChunk || '');
  }
  updateLiveStreamView();
}

function clearSessionData() {
  segments.clear();
  keyAlias.clear();
  liveText = '';
  segmentOrder = 0;
  audioQueue.length = 0;
  spokenKeys.clear();
  isPlayingAudio = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  renderManuscript();
  updateLiveStreamView();
}

// ═════════════════════════════════════════════
// SESSION STATUS & BANNERS
// ═════════════════════════════════════════════
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

// ═════════════════════════════════════════════
// WEBSOCKET & BACKGROUND SYNC (Zero-Wipe Guarantee)
// ═════════════════════════════════════════════
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
      if (data.type === 'SESSION_CLEAR_TEXT') {
        clearSessionData();
      }
      if (data.type === 'SESSION_DELETED') {
        clearSessionData();
        updateMobileStatus('ended', 'Session Concluded');
      }
      if (data.type === 'STREAMING_TOKEN') {
        handleStreamingTokenMobile(data);
      }
      if (data.type === 'LIVE_SUBTITLE') {
        const key = segKey(data);
        if (!segments.has(key)) {
          commitSentence(data);
        }
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2500);
  };
}

// Poll fallback for offline recovery (Strictly NON-DESTRUCTIVE)
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

      // DO NOT clear if transcripts length === 0! Empty delta is expected during speaking pauses.
      if (data.transcripts && data.transcripts.length > 0) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          data.transcripts.forEach(item => {
            const key = segKey(item);
            if (!segments.has(key)) {
              commitSentence(item);
            }
          });
        }
      }
    } catch (e) {}
  }, 2500);
}

// ═════════════════════════════════════════════
// STEP NAVIGATION & IN-STREAM LANGUAGE MODAL
// ═════════════════════════════════════════════
function showStep(num) {
  step1.classList.remove('active');
  step2.classList.remove('active');
  step3.classList.remove('active');

  const target = $('step' + num);
  if (target) target.classList.add('active');
}

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

if (btnBack) {
  btnBack.addEventListener('click', () => {
    openLangModal();
  });
}

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

      // Instantly switch language in WebSocket gate
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'JOIN_ROOM',
          sessionId,
          role: 'attendee',
          language: currentLanguage
        }));
      }

      // Re-render whole manuscript in new language
      renderManuscript();
      updateLiveStreamView();
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

// ═════════════════════════════════════════════
// SESSION INITIALIZATION
// ═════════════════════════════════════════════
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
      if (data.status) updateMobileStatus(data.status, data.mosqueName);
      return data;
    }
  } catch (err) {}
  return null;
}
fetchMosqueDetails();

async function initLiveSession() {
  updateLangDisplay();
  const sessionData = await fetchMosqueDetails();

  // Restore existing history on join/refresh
  if (sessionData && sessionData.transcripts && sessionData.transcripts.length > 0) {
    sessionData.transcripts.forEach(item => {
      const key = segKey(item);
      if (!segments.has(key)) {
        segments.set(key, {
          key,
          translations: item.translations || {},
          arabic: item.arabic || '',
          ayah: item.ayah || null,
          ts: item.timestamp || new Date().toISOString(),
          order: ++segmentOrder
        });
        registerAlias(key, item);
      }
    });
    renderManuscript();
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
