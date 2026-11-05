// MosqAI - Live TV Display Engine (Strict ES5 Compatible for Smart TVs)
// Supports Samsung Tizen, LG webOS, Android TV, and Legacy TV WebViews

(function () {
  'use strict';

  // ─── ES5 MICRO-POLYFILLS & UTILITY HELPERS ───
  function safeIncludes(arr, val) {
    if (!arr || !arr.length) return false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === val) return true;
    }
    return false;
  }

  function safeIndexOf(arr, val) {
    if (!arr || !arr.length) return -1;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === val) return i;
    }
    return -1;
  }

  function safeStartsWith(str, prefix) {
    if (typeof str !== 'string' || typeof prefix !== 'string') return false;
    return str.indexOf(prefix) === 0;
  }

  function safeTrim(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/^\s+|\s+$/g, '');
  }

  function safeTrimStart(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/^\s+/, '');
  }

  function safeValues(obj) {
    var vals = [];
    if (!obj || typeof obj !== 'object') return vals;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        vals.push(obj[k]);
      }
    }
    return vals;
  }

  function safeAssign(target, source) {
    if (!target) target = {};
    if (!source || typeof source !== 'object') return target;
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
      }
    }
    return target;
  }

  function safeFind(arr, predicate) {
    if (!arr || !arr.length) return null;
    for (var i = 0; i < arr.length; i++) {
      if (predicate(arr[i], i, arr)) return arr[i];
    }
    return null;
  }

  function safeAjax(url, options, callback) {
    var xhr = null;
    try {
      xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new window.ActiveXObject('Microsoft.XMLHTTP');
    } catch (e) {
      if (callback) callback(new Error('XHR unavailable'), null);
      return;
    }

    var method = (options && options.method) ? options.method.toUpperCase() : 'GET';
    var headers = (options && options.headers) ? options.headers : {};
    var data = (options && options.body) ? options.body : null;

    xhr.open(method, url, true);

    for (var headerKey in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, headerKey)) {
        xhr.setRequestHeader(headerKey, headers[headerKey]);
      }
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = null;
          try {
            parsed = JSON.parse(xhr.responseText);
          } catch (err) {
            parsed = xhr.responseText;
          }
          if (callback) callback(null, parsed, xhr.status);
        } else {
          var errObj = new Error('HTTP ' + xhr.status + ': ' + xhr.statusText);
          errObj.status = xhr.status;
          if (callback) callback(errObj, null, xhr.status);
        }
      }
    };

    xhr.onerror = function () {
      if (callback) callback(new Error('Network request failed'), null, 0);
    };

    try {
      xhr.send(data);
    } catch (sendErr) {
      if (callback) callback(sendErr, null, 0);
    }
  }

  function getQueryParam(name) {
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      var search = window.location.search;
      var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)');
      var results = regex.exec(search);
      if (!results || !results[2]) return null;
      try {
        return decodeURIComponent(results[2].replace(/\+/g, ' '));
      } catch (_) {
        return results[2];
      }
    }
    return null;
  }

  // ─── CONSTANTS & CONFIGURATION ───
  var VALID_LANGS = ['en', 'uz', 'tr', 'ur', 'bn', 'fr', 'zh', 'zh-TW', 'id', 'so'];
  var VALID_SOURCE_LANGS = ['auto', 'ar', 'en', 'uz', 'tr', 'ur', 'bn', 'fr', 'zh', 'zh-TW', 'id', 'so'];

  var LANG_BCP47_MAP = {
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

  var TV_FONT_PRESETS = {
    small: { scale: 0.8, capacity: 18 },
    medium: { scale: 1.0, capacity: 12 },
    large: { scale: 1.25, capacity: 8 },
    xlarge: { scale: 1.5, capacity: 5 }
  };

  var MALE_VOICE_KEYWORDS = [
    'male', 'david', 'mark', 'george', 'guy', 'paul', 'daniel', 'thomas',
    'alex', 'fred', 'oliver', 'arthur', 'aaron', 'james', 'nathan', 'rishi',
    'tarik', 'mehdi', 'salman', 'ali', 'hakan', 'berk', 'cem', 'deep', 'baritone'
  ];

  var FEMALE_VOICE_KEYWORDS = [
    'female', 'zira', 'susan', 'samantha', 'victoria', 'karen', 'moira',
    'fiona', 'tessa', 'veena', 'yelda', 'filiz', 'amira', 'zeina', 'salma',
    'camille', 'clara', 'marie', 'anna', 'helena', 'eva', 'laura', 'lucia'
  ];

  // ─── STATE VARIABLES ───
  var querySessionId = getQueryParam('session');
  var sessionId = querySessionId || null;
  var isAutoDiscovering = !querySessionId;
  var autoDiscoverInterval = null;

  var currentMosqueName = 'Masjid Al-Noor';
  var targetLang = 'en';
  var userExplicitlySelectedLang = false;
  var sourceLang = 'auto';
  var screenMode = 'split';

  var MAX_HISTORY = 12;
  var currentTvFontSize = 'medium';
  var isTvAudioEnabled = false;
  var isTvQrVisible = true;

  var ws = null;
  var lastWsMessageTime = 0;
  var feedSyncInterval = null;
  var tvHeartbeatInterval = null;
  var seenKeys = {};
  var lastSeqReceived = 0;
  var lastTimestampReceived = null;
  var recentFeedItems = [];
  var activeStreamCleanups = [];

  // ─── CLIENT ID GENERATION ───
  function getTvClientId() {
    var cid = '';
    try {
      cid = localStorage.getItem('mosq_tv_client_id');
      if (!cid) {
        cid = 'tv_' + Math.random().toString(36).substring(2, 9) + (new Date()).getTime().toString(36);
        localStorage.setItem('mosq_tv_client_id', cid);
      }
    } catch (e) {
      cid = 'tv_' + Math.random().toString(36).substring(2, 9);
    }
    return cid;
  }
  var tvClientId = getTvClientId();

  // ─── INITIAL SETTINGS EXTRACTION ───
  var urlLang = getQueryParam('lang');
  if (urlLang && safeIncludes(VALID_LANGS, urlLang)) {
    targetLang = urlLang;
    userExplicitlySelectedLang = true;
  } else {
    try {
      var savedLang = localStorage.getItem('mosq_tv_lang');
      if (savedLang && safeIncludes(VALID_LANGS, savedLang)) {
        targetLang = savedLang;
        userExplicitlySelectedLang = true;
      }
    } catch (_) {}
  }

  var urlSource = getQueryParam('sourceLang');
  if (urlSource && safeIncludes(VALID_SOURCE_LANGS, urlSource)) {
    sourceLang = urlSource;
  } else {
    try {
      var savedSource = localStorage.getItem('mosq_tv_source_lang');
      if (savedSource && safeIncludes(VALID_SOURCE_LANGS, savedSource)) {
        sourceLang = savedSource;
      }
    } catch (_) {}
  }

  var urlMode = getQueryParam('mode');
  if (urlMode === 'translation-only' || urlMode === 'trans-only' || urlMode === 'single') {
    screenMode = 'translation-only';
  } else if (urlMode === 'split' || urlMode === 'dual') {
    screenMode = 'split';
  } else {
    try {
      var savedMode = localStorage.getItem('mishkah_tv_screen_mode') || localStorage.getItem('mosq_tv_screen_mode');
      if (savedMode === 'translation-only' || savedMode === 'split') {
        screenMode = savedMode;
      }
    } catch (_) {}
  }

  // ─── DOM ELEMENT REFERENCES ───
  var bootMsgEl = null;
  var bootMsgTextEl = null;
  var bootErrEl = null;
  var mosqueNameEl = null;
  var stageStatusBanner = null;
  var stageStatusText = null;
  var liveDotIndicator = null;
  var sourceLangSelect = null;
  var targetLangSelect = null;
  var screenModeSelect = null;
  var arabicCol = null;
  var arabicFeed = null;
  var transFeed = null;
  var qrImg = null;
  var qrWidget = null;
  var btnFullscreen = null;

  function initDomReferences() {
    bootMsgEl = document.getElementById('boot-msg');
    bootMsgTextEl = document.getElementById('boot-msg-text');
    bootErrEl = document.getElementById('boot-err');
    mosqueNameEl = document.getElementById('mosque-name');
    stageStatusBanner = document.getElementById('stage-status-banner');
    stageStatusText = document.getElementById('stage-status-text');
    liveDotIndicator = document.getElementById('live-dot-indicator');
    sourceLangSelect = document.getElementById('source-lang-select');
    targetLangSelect = document.getElementById('target-lang-select');
    screenModeSelect = document.getElementById('screen-mode-select');
    arabicCol = document.getElementById('arabic-col');
    arabicFeed = document.getElementById('arabic-feed');
    transFeed = document.getElementById('trans-feed');
    qrImg = document.getElementById('qr-img');
    qrWidget = document.getElementById('qr-widget');
    btnFullscreen = document.getElementById('btn-fullscreen');
  }

  // ─── LAYOUT & SCREEN MODE ───
  function applyScreenMode(mode) {
    screenMode = (mode === 'translation-only') ? 'translation-only' : 'split';
    if (document.body) {
      if (screenMode === 'translation-only') {
        document.body.className = (document.body.className + ' screen-mode-trans-only').replace(/\s+/g, ' ');
      } else {
        document.body.className = document.body.className.replace(/\bscreen-mode-trans-only\b/g, '').replace(/\s+/g, ' ');
      }
    }
    if (screenModeSelect && screenModeSelect.value !== screenMode) {
      screenModeSelect.value = screenMode;
    }
    try {
      localStorage.setItem('mishkah_tv_screen_mode', screenMode);
    } catch (_) {}
  }

  // ─── TV FONT SIZE & CAPACITY ───
  function applyTvFontSize(fontSize, customCapacity, shouldScroll) {
    if (!fontSize) return;
    currentTvFontSize = fontSize;

    var scale = 1.0;
    var capacity = 12;

    if (typeof fontSize === 'string' && TV_FONT_PRESETS[fontSize]) {
      scale = TV_FONT_PRESETS[fontSize].scale;
      capacity = customCapacity ? Number(customCapacity) : TV_FONT_PRESETS[fontSize].capacity;
    } else if (!isNaN(Number(fontSize))) {
      var num = Number(fontSize);
      scale = num > 2 ? num / 100 : num;
      capacity = customCapacity ? Number(customCapacity) : Math.max(4, Math.round(12 / (scale || 1)));
    }

    MAX_HISTORY = capacity;
    if (document.documentElement && document.documentElement.style) {
      try {
        document.documentElement.style.setProperty('--tv-font-scale', scale);
      } catch (_) {}
    }

    try {
      localStorage.setItem('mosq_tv_font_size', fontSize);
      if (customCapacity) localStorage.setItem('mosq_tv_capacity', customCapacity);
    } catch (_) {}

    while (recentFeedItems.length > MAX_HISTORY) {
      recentFeedItems.shift();
    }
    if (arabicFeed) {
      while (arabicFeed.children.length > MAX_HISTORY) {
        if (arabicFeed.firstElementChild) arabicFeed.removeChild(arabicFeed.firstElementChild);
      }
    }
    if (transFeed) {
      while (transFeed.children.length > MAX_HISTORY) {
        if (transFeed.firstElementChild) transFeed.removeChild(transFeed.firstElementChild);
      }
    }

    if (shouldScroll) {
      setTimeout(function () {
        scrollFeedsToBottom();
      }, 50);
    }
  }

  function scrollFeedsToBottom() {
    try {
      if (arabicFeed && arabicFeed.parentElement) {
        arabicFeed.parentElement.scrollTop = arabicFeed.parentElement.scrollHeight;
      }
      if (transFeed && transFeed.parentElement) {
        transFeed.parentElement.scrollTop = transFeed.parentElement.scrollHeight;
      }
    } catch (_) {}
  }

  // ─── AUDIO (SPEECH SYNTHESIS) ───
  function setTvAudioState(enabled) {
    isTvAudioEnabled = Boolean(enabled);
    if (!isTvAudioEnabled && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (_) {}
    }
  }

  function getBestMaleVoice(langCode) {
    if (!('speechSynthesis' in window)) return null;
    var voices = [];
    try {
      voices = window.speechSynthesis.getVoices() || [];
    } catch (_) {
      return null;
    }
    if (!voices.length) return null;

    var targetPrefix = (langCode || 'en').toLowerCase().split('-')[0];
    var matching = [];
    for (var i = 0; i < voices.length; i++) {
      var vLang = (voices[i].lang || '').toLowerCase().replace(/_/g, '-');
      if (safeStartsWith(vLang, targetPrefix)) {
        matching.push(voices[i]);
      }
    }

    var pool = matching.length > 0 ? matching : voices;

    for (var j = 0; j < pool.length; j++) {
      var v = pool[j];
      var nameLower = (v.name || '').toLowerCase();
      var uriLower = (v.voiceURI || '').toLowerCase();
      var isMale = false;
      for (var m = 0; m < MALE_VOICE_KEYWORDS.length; m++) {
        if (nameLower.indexOf(MALE_VOICE_KEYWORDS[m]) !== -1 || uriLower.indexOf(MALE_VOICE_KEYWORDS[m]) !== -1) {
          isMale = true;
          break;
        }
      }
      var isFemale = false;
      for (var f = 0; f < FEMALE_VOICE_KEYWORDS.length; f++) {
        if (nameLower.indexOf(FEMALE_VOICE_KEYWORDS[f]) !== -1 || uriLower.indexOf(FEMALE_VOICE_KEYWORDS[f]) !== -1) {
          isFemale = true;
          break;
        }
      }
      if (isMale && !isFemale) {
        return v;
      }
    }

    return pool[0] || null;
  }

  function playTvBrowserAudio(text, langCode) {
    if (!isTvAudioEnabled) return;
    if (!('speechSynthesis' in window)) return;
    if (!text || typeof text !== 'string') return;

    var cleanText = safeTrim(text);
    if (!cleanText) return;

    try {
      if (window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
      var utterance = new window.SpeechSynthesisUtterance(cleanText);
      var bcpTag = LANG_BCP47_MAP[langCode] || langCode || 'en-US';
      utterance.lang = bcpTag;

      var maleVoice = getBestMaleVoice(langCode);
      if (maleVoice) {
        utterance.voice = maleVoice;
      }
      utterance.pitch = 0.92;
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (err) {}
  }

  var hasUnlockedTvAudio = false;
  function unlockTvAudio() {
    if (hasUnlockedTvAudio) return;
    hasUnlockedTvAudio = true;
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
        var silent = new window.SpeechSynthesisUtterance('');
        silent.volume = 0;
        window.speechSynthesis.speak(silent);
      }
    } catch (_) {}
  }
  document.addEventListener('click', unlockTvAudio);
  document.addEventListener('keydown', unlockTvAudio);
  document.addEventListener('touchstart', unlockTvAudio);

  // ─── QR CODE & CONTROLS ───
  function setTvQrVisibility(visible) {
    isTvQrVisible = visible !== false;
    if (qrWidget) {
      qrWidget.style.display = isTvQrVisible ? 'flex' : 'none';
    }
  }

  function initQRCode() {
    if (!qrImg) return;
    var currentSid = sessionId || 'live';
    var origin = window.location.protocol + '//' + window.location.host;
    var joinUrl = origin + '/join.html?session=' + encodeURIComponent(currentSid) + '&lang=' + encodeURIComponent(targetLang);
    qrImg.src = '/api/qrcode?text=' + encodeURIComponent(joinUrl);
    qrImg.onerror = function () {
      qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(joinUrl);
    };
  }

  // ─── SOURCE COLUMN STYLING ───
  var spokenSeqs = {};

  function hasArabicScript(text) {
    return /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text || '');
  }

  function isRawArabicLeak(str) {
    if (!str || typeof str !== 'string') return false;
    var arabicCount = 0;
    var otherCount = 0;
    var totalAlpha = 0;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if ((code >= 0x0600 && code <= 0x06FF) ||
          (code >= 0x0750 && code <= 0x077F) ||
          (code >= 0xFB50 && code <= 0xFDFF) ||
          (code >= 0xFE70 && code <= 0xFEFF)) {
        arabicCount++;
        totalAlpha++;
      } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
                 (code >= 0x0400 && code <= 0x04FF) || // Cyrillic
                 (code >= 0x0980 && code <= 0x09FF) || // Bengali
                 (code >= 0x4E00 && code <= 0x9FFF)) { // Chinese
        otherCount++;
        totalAlpha++;
      }
    }
    if (totalAlpha === 0) return false;
    if (otherCount > 0 && (otherCount / totalAlpha) > 0.2) return false;
    return (arabicCount / totalAlpha) > 0.75;
  }

  function updateSourceColumnStyling() {
    if (!arabicCol) return;
    var isRtl = sourceLang === 'ar' || sourceLang === 'ur';
    arabicCol.style.direction = isRtl ? 'rtl' : (sourceLang === 'auto' ? 'auto' : 'ltr');
    arabicCol.style.textAlign = isRtl ? 'right' : (sourceLang === 'auto' ? 'inherit' : 'left');

    if (document.body && document.body.className.indexOf('session-active') !== -1) {
      var ph = arabicFeed ? arabicFeed.querySelector('.idle-placeholder') : null;
      if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
      return;
    }

    var placeholder = arabicFeed ? arabicFeed.querySelector('.idle-placeholder') : null;
    if (placeholder) {
      if (sourceLang === 'ar') placeholder.textContent = 'في انتظار بدء الخطبة...';
      else if (sourceLang === 'ur') placeholder.textContent = 'خطبہ شروع ہونے کا انتظار ہے...';
      else if (sourceLang === 'tr') placeholder.textContent = 'Hutbenin başlaması bekleniyor...';
      else if (sourceLang === 'uz') placeholder.textContent = 'Xutba boshlanishini kuting...';
      else if (sourceLang === 'fr') placeholder.textContent = 'En attente du début du sermon...';
      else if (sourceLang === 'zh' || sourceLang === 'zh-TW') placeholder.textContent = '等待演讲开始...';
      else if (sourceLang === 'bn') placeholder.textContent = 'বক্তব্য শুরু হওয়ার অপেক্ষায়...';
      else if (sourceLang === 'id') placeholder.textContent = 'Menunggu khutbah dimulai...';
      else if (sourceLang === 'so') placeholder.textContent = 'Sugitaanka khudbada...';
      else if (sourceLang === 'en') placeholder.textContent = 'Waiting for speech to begin...';
      else placeholder.textContent = 'في انتظار بدء الخطبة... / Listening...';
    }
  }

  // ─── UI STATUS & BANNER ───
  function updateTVStatusUI(status, mosqueName) {
    if (mosqueName) currentMosqueName = mosqueName;
    if (mosqueNameEl) mosqueNameEl.textContent = currentMosqueName;

    if (status === 'active') {
      if (bootMsgEl) bootMsgEl.style.display = 'none';
      if (document.body && document.body.className.indexOf('session-active') === -1) {
        document.body.className = (document.body.className + ' session-active').replace(/\s+/g, ' ');
      }
      var placeholders = document.querySelectorAll('.idle-placeholder');
      for (var p = 0; p < placeholders.length; p++) {
        if (placeholders[p].parentNode) placeholders[p].parentNode.removeChild(placeholders[p]);
      }
      if (liveDotIndicator) liveDotIndicator.style.display = 'block';
      if (stageStatusBanner) {
        stageStatusBanner.style.display = 'block';
        stageStatusBanner.style.background = 'rgba(16, 185, 129, 0.2)';
        stageStatusBanner.style.border = '1px solid rgba(16, 185, 129, 0.4)';
        stageStatusBanner.style.color = '#34d399';
        if (stageStatusText) stageStatusText.textContent = currentMosqueName + ' — LIVE';
      }
    } else {
      if (document.body) {
        document.body.className = document.body.className.replace(/\bsession-active\b/g, '').replace(/\s+/g, ' ');
      }
      if (status === 'paused') {
        if (liveDotIndicator) liveDotIndicator.style.display = 'none';
        if (stageStatusBanner) {
          stageStatusBanner.style.display = 'block';
          stageStatusBanner.style.background = 'rgba(245, 158, 11, 0.25)';
          stageStatusBanner.style.border = '1px solid rgba(245, 158, 11, 0.4)';
          stageStatusBanner.style.color = '#fde68a';
          if (stageStatusText) stageStatusText.textContent = currentMosqueName + ' — Live Translation Paused';
        }
      } else if (status === 'ended') {
        if (liveDotIndicator) liveDotIndicator.style.display = 'none';
        if (stageStatusBanner) {
          stageStatusBanner.style.display = 'block';
          stageStatusBanner.style.background = 'rgba(239, 68, 68, 0.25)';
          stageStatusBanner.style.border = '1px solid rgba(239, 68, 68, 0.4)';
          stageStatusBanner.style.color = '#fca5a5';
          if (stageStatusText) stageStatusText.textContent = currentMosqueName + ' — Session Ended';
        }
      } else {
        if (liveDotIndicator) liveDotIndicator.style.display = 'none';
        if (stageStatusBanner) stageStatusBanner.style.display = 'none';
        if (bootMsgEl && (!sessionId || isAutoDiscovering)) {
          bootMsgEl.style.display = 'block';
          if (bootMsgTextEl) {
            bootMsgTextEl.textContent = 'Waiting for sermon to begin at ' + currentMosqueName + '…';
          }
        }
      }
    }
  }

  function clearTvFeeds() {
    recentFeedItems.length = 0;
    seenKeys = {};
    spokenSeqs = {};
    clearActiveStreams();
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    var isLive = document.body && document.body.className.indexOf('session-active') !== -1;
    if (arabicFeed) {
      arabicFeed.innerHTML = isLive ? '' : '<div class="idle-placeholder">في انتظار بدء الخطبة...</div>';
      if (!isLive) updateSourceColumnStyling();
    }
    if (transFeed) {
      transFeed.innerHTML = isLive ? '' : '<div class="idle-placeholder">Waiting for sermon to begin...</div>';
    }
  }

  function clearActiveStreams() {
    for (var i = 0; i < activeStreamCleanups.length; i++) {
      try { activeStreamCleanups[i](); } catch (_) {}
    }
    activeStreamCleanups = [];
  }

  // ─── WORD-BY-WORD STREAMING & RENDERING ───
  function streamWordsIntoElement(element, fullText, delayMs, onComplete) {
    if (typeof delayMs === 'undefined') delayMs = 85;
    var words = safeTrim(fullText).split(/\s+/);
    element.textContent = '';
    element.className = (element.className + ' streaming').replace(/\s+/g, ' ');
    var idx = 0;

    var timer = setInterval(function () {
      if (idx < words.length) {
        var span = document.createElement('span');
        span.className = 'stream-word';
        span.textContent = (idx === 0 ? '' : ' ') + words[idx];
        element.appendChild(span);
        idx++;
        scrollFeedsToBottom();
      } else {
        clearInterval(timer);
        element.className = element.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
        if (onComplete) onComplete();
      }
    }, delayMs);

    var cleanup = function () {
      clearInterval(timer);
      element.className = element.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
      element.textContent = fullText;
    };
    activeStreamCleanups.push(cleanup);
    return cleanup;
  }

  function getValidTranslationText(transObj, lang) {
    if (!transObj) return '';
    var isArabicTarget = (lang === 'ar' || lang === 'ur');
    function isCorrupt(str) {
      if (!str || typeof str !== 'string' || !safeTrim(str)) return true;
      if (safeStartsWith(str, '[' + lang.toUpperCase() + ']')) return true;
      if (!isArabicTarget && isRawArabicLeak(str)) return true;
      return false;
    }

    if (typeof transObj === 'object') {
      var direct = transObj[lang];
      if (direct && !isCorrupt(direct)) return direct;
      // Strict boundary: Only return English if targetLang is explicitly English
      if (lang === 'en' && transObj.en && !isCorrupt(transObj.en)) {
        return transObj.en;
      }
      return '';
    }
    if (typeof transObj === 'string' && !isCorrupt(transObj)) {
      return transObj;
    }
    return '';
  }

  function reRenderTranslationFeed() {
    clearActiveStreams();
    if (!transFeed) return;
    transFeed.innerHTML = '';
    var isLive = document.body && document.body.className.indexOf('session-active') !== -1;
    if (recentFeedItems.length === 0) {
      if (!isLive) {
        transFeed.innerHTML = '<div class="idle-placeholder">Waiting for sermon to begin...</div>';
      }
    } else {
      for (var i = 0; i < recentFeedItems.length; i++) {
        var item = recentFeedItems[i];
        var isCurrent = (i === recentFeedItems.length - 1);
        var pTrans = document.createElement('div');
        pTrans.className = 'para-item ' + (isCurrent ? 'current' : 'history');
        if (item.seq) {
          pTrans.setAttribute('data-seq', 'seq_' + item.seq);
        }
        var text = getValidTranslationText(item.transObj, targetLang);
        pTrans.textContent = text || '…';
        transFeed.appendChild(pTrans);
      }
      scrollFeedsToBottom();
    }
  }

  function appendToFeed(arabicText, transObj, isLive, seqKey) {
    if (typeof isLive === 'undefined') isLive = true;
    if (!arabicText && !transObj) return;

    var phA = arabicFeed ? arabicFeed.querySelector('.idle-placeholder') : null;
    if (phA && phA.parentNode) phA.parentNode.removeChild(phA);
    var phT = transFeed ? transFeed.querySelector('.idle-placeholder') : null;
    if (phT && phT.parentNode) phT.parentNode.removeChild(phT);

    recentFeedItems.push({ arabicText: arabicText, transObj: transObj });
    while (recentFeedItems.length > MAX_HISTORY) {
      recentFeedItems.shift();
    }

    // 1. Source column
    var isSourceRtl = hasArabicScript(arabicText) || sourceLang === 'ar' || sourceLang === 'ur';
    var isValidSource = arabicText && (sourceLang === 'ar' ? hasArabicScript(arabicText) : safeTrim(arabicText).length > 0);

    if (isValidSource && arabicFeed) {
      var prevA = arabicFeed.querySelectorAll('.para-item.current');
      for (var a = 0; a < prevA.length; a++) {
        prevA[a].className = prevA[a].className.replace(/\bcurrent\b/g, '').replace(/\s+/g, ' ') + ' history';
      }

      var pArabic = document.createElement('div');
      pArabic.className = 'para-item current';
      if (seqKey) {
        pArabic.setAttribute('data-seq', seqKey);
      }
      if (isSourceRtl) {
        pArabic.style.direction = 'rtl';
        pArabic.style.textAlign = 'right';
        pArabic.style.fontFamily = "'Amiri', 'Traditional Arabic', serif";
      } else {
        pArabic.style.direction = 'ltr';
        pArabic.style.textAlign = 'left';
        pArabic.style.fontFamily = "'Plus Jakarta Sans', sans-serif";
      }
      pArabic.textContent = arabicText;
      arabicFeed.appendChild(pArabic);

      while (arabicFeed.children.length > MAX_HISTORY) {
        arabicFeed.removeChild(arabicFeed.firstElementChild);
      }
    }

    // 2. Translation column
    var displayTrans = '';
    if (typeof transObj === 'object' && transObj !== null) {
      displayTrans = getValidTranslationText(transObj, targetLang);
    } else if (typeof transObj === 'string') {
      displayTrans = transObj;
    }

    if (transFeed) {
      var prevT = transFeed.querySelectorAll('.para-item.current');
      for (var t = 0; t < prevT.length; t++) {
        prevT[t].className = prevT[t].className.replace(/\bcurrent\b/g, '').replace(/\s+/g, ' ') + ' history';
      }

      var pTrans = document.createElement('div');
      pTrans.className = 'para-item current' + (displayTrans ? '' : ' translating-placeholder');
      if (seqKey) {
        pTrans.setAttribute('data-seq', seqKey);
      }
      pTrans.textContent = displayTrans || '…';
      transFeed.appendChild(pTrans);

      if (displayTrans && isTvAudioEnabled && isLive && (!seqKey || !spokenSeqs[seqKey])) {
        if (seqKey) spokenSeqs[seqKey] = true;
        playTvBrowserAudio(displayTrans, targetLang);
      }

      while (transFeed.children.length > MAX_HISTORY) {
        transFeed.removeChild(transFeed.firstElementChild);
      }
    }

    setTimeout(function () {
      scrollFeedsToBottom();
    }, 50);
  }

  function handleIncomingSpeech(data, isLive) {
    if (typeof isLive === 'undefined') isLive = true;
    if (!data) return;
    var arabic = data.arabic;
    var translations = data.translations;
    var translated = data.translated;
    var seq = data.seq || 0;
    var timestamp = data.timestamp || null;
    var seqKey = seq ? ('seq_' + seq) : (timestamp ? ('ts_' + timestamp.replace(/[^a-zA-Z0-9]/g, '')) : null);

    if (!arabic && !translated && !translations) return;

    var transObj = translations;
    if (!transObj && translated) {
      transObj = {};
      transObj[targetLang] = translated;
    }

    var displayTrans = getValidTranslationText(transObj, targetLang);

    // Keyed idempotency: if an item with this data-seq exists in the DOM, update in place
    if (seqKey) {
      var exA = arabicFeed ? arabicFeed.querySelector('[data-seq="' + seqKey + '"]') : null;
      var exT = transFeed ? transFeed.querySelector('[data-seq="' + seqKey + '"]') : null;
      if (exA || exT) {
        if (exA && arabic) {
          exA.textContent = arabic;
          exA.className = exA.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
        }
        if (exT && displayTrans) {
          exT.textContent = displayTrans;
          exT.className = exT.className.replace(/\b(streaming|translating-placeholder)\b/g, '').replace(/\s+/g, ' ');
          if (isTvAudioEnabled && isLive && !spokenSeqs[seqKey]) {
            spokenSeqs[seqKey] = true;
            playTvBrowserAudio(displayTrans, targetLang);
          }
        }
        return;
      }
    }

    var streamingArabic = arabicFeed ? arabicFeed.querySelector('.para-item.current.streaming') : null;
    var streamingTrans = transFeed ? transFeed.querySelector('.para-item.current.streaming') : null;
    var currentArabic = arabicFeed ? arabicFeed.querySelector('.para-item.current') : null;
    var currentTrans = transFeed ? transFeed.querySelector('.para-item.current') : null;

    if (streamingArabic || streamingTrans) {
      if (streamingArabic && arabic) {
        var isValid = (sourceLang === 'ar' ? hasArabicScript(arabic) : safeTrim(arabic).length > 0);
        if (isValid) {
          var isRtl = hasArabicScript(arabic) || sourceLang === 'ar' || sourceLang === 'ur';
          streamingArabic.style.direction = isRtl ? 'rtl' : 'ltr';
          streamingArabic.style.textAlign = isRtl ? 'right' : 'left';
          streamingArabic.style.fontFamily = isRtl ? "'Amiri', 'Traditional Arabic', serif" : "'Plus Jakarta Sans', sans-serif";
          streamingArabic.className = streamingArabic.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
          streamingArabic.textContent = arabic;
          if (seqKey) streamingArabic.setAttribute('data-seq', seqKey);
        } else if (streamingArabic.parentNode) {
          streamingArabic.parentNode.removeChild(streamingArabic);
        }
      }
      if (streamingTrans) {
        streamingTrans.className = streamingTrans.className.replace(/\b(streaming|translating-placeholder)\b/g, '').replace(/\s+/g, ' ');
        if (displayTrans) {
          streamingTrans.textContent = displayTrans;
          if (seqKey) streamingTrans.setAttribute('data-seq', seqKey);
          if (isTvAudioEnabled && isLive && (!seqKey || !spokenSeqs[seqKey])) {
            if (seqKey) spokenSeqs[seqKey] = true;
            playTvBrowserAudio(displayTrans, targetLang);
          }
        }
      }
      var keepArabic = arabic && (sourceLang === 'ar' ? hasArabicScript(arabic) : safeTrim(arabic).length > 0);
      recentFeedItems.push({ arabicText: keepArabic ? arabic : '', transObj: transObj });
      while (recentFeedItems.length > MAX_HISTORY) recentFeedItems.shift();
      return;
    }

    var arabicMatch = currentArabic && arabic && safeTrim(currentArabic.textContent) === safeTrim(arabic);
    var transMatch = currentTrans && displayTrans && safeTrim(currentTrans.textContent) === safeTrim(displayTrans);
    if (arabicMatch || transMatch) {
      if (seqKey) {
        if (currentArabic) currentArabic.setAttribute('data-seq', seqKey);
        if (currentTrans) currentTrans.setAttribute('data-seq', seqKey);
      }
      var keepA = arabic && (sourceLang === 'ar' ? hasArabicScript(arabic) : safeTrim(arabic).length > 0);
      recentFeedItems.push({ arabicText: keepA ? arabic : '', transObj: transObj });
      while (recentFeedItems.length > MAX_HISTORY) recentFeedItems.shift();
      return;
    }

    var validArabic = arabic && (sourceLang === 'ar' ? (hasArabicScript(arabic) ? arabic : '') : arabic);
    appendToFeed(validArabic, transObj, isLive, seqKey);
  }

  function handleStreamingToken(data) {
    if (!data) return;
    var lang = data.lang;
    var translatedChunk = data.translatedChunk || '';
    var originalChunk = data.originalChunk || '';
    var originalFull = data.originalFull || '';
    var translatedFull = data.translatedFull || '';
    var isReplacement = Boolean(data.isReplacement);
    var isFinal = Boolean(data.isFinal);
    var seq = data.seq || 0;
    var timestamp = data.timestamp || null;
    var seqKey = seq ? ('seq_' + seq) : (timestamp ? ('ts_' + timestamp.replace(/[^a-zA-Z0-9]/g, '')) : null);

    if (lang && lang !== targetLang) {
      return;
    }

    var phA = arabicFeed ? arabicFeed.querySelector('.idle-placeholder') : null;
    if (phA && phA.parentNode) phA.parentNode.removeChild(phA);
    var phT = transFeed ? transFeed.querySelector('.idle-placeholder') : null;
    if (phT && phT.parentNode) phT.parentNode.removeChild(phT);

    // 1. Source column
    var sourceContent = isReplacement ? originalFull : originalChunk;
    var isSourceRtl = hasArabicScript(sourceContent) || sourceLang === 'ar' || sourceLang === 'ur';
    var isValidSource = sourceContent && (sourceLang === 'ar' ? hasArabicScript(sourceContent) : safeTrim(sourceContent).length > 0);

    if (isValidSource && arabicFeed) {
      var currentArabic = null;
      if (seqKey) {
        currentArabic = arabicFeed.querySelector('[data-seq="' + seqKey + '"]');
      }
      if (!currentArabic) {
        currentArabic = arabicFeed.querySelector('.para-item.current.streaming');
      }

      if (currentArabic) {
        var isArabicFinalized = currentArabic.className.indexOf('streaming') === -1;
        if (isArabicFinalized && !isFinal) {
          // Stale provisional partial arrived after finalization: ignore to prevent rollback
        } else {
          if (isReplacement) {
            currentArabic.textContent = safeTrimStart(sourceContent);
          } else {
            currentArabic.textContent = safeTrimStart(currentArabic.textContent + sourceContent);
          }
          if (seqKey && !currentArabic.getAttribute('data-seq')) {
            currentArabic.setAttribute('data-seq', seqKey);
          }
          if (isFinal) {
            currentArabic.className = currentArabic.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
          }
        }
      } else {
        var prevs = arabicFeed.querySelectorAll('.para-item.current');
        for (var p = 0; p < prevs.length; p++) {
          prevs[p].className = prevs[p].className.replace(/\b(current|streaming)\b/g, '').replace(/\s+/g, ' ') + ' history';
        }
        currentArabic = document.createElement('div');
        currentArabic.className = 'para-item current' + (isFinal ? '' : ' streaming');
        if (seqKey) {
          currentArabic.setAttribute('data-seq', seqKey);
        }
        if (isSourceRtl) {
          currentArabic.style.direction = 'rtl';
          currentArabic.style.textAlign = 'right';
          currentArabic.style.fontFamily = "'Amiri', 'Traditional Arabic', serif";
        } else {
          currentArabic.style.direction = 'ltr';
          currentArabic.style.textAlign = 'left';
          currentArabic.style.fontFamily = "'Plus Jakarta Sans', sans-serif";
        }
        currentArabic.textContent = safeTrimStart(sourceContent);
        arabicFeed.appendChild(currentArabic);
      }

      while (arabicFeed.children.length > MAX_HISTORY) {
        arabicFeed.removeChild(arabicFeed.firstElementChild);
      }
      scrollFeedsToBottom();

      // Placeholder on right if translation has not arrived yet
      var transContentCheck = isReplacement ? translatedFull : translatedChunk;
      if ((!transContentCheck || safeTrim(transContentCheck).length === 0) && !isFinal && transFeed) {
        var currentTransHolder = null;
        if (seqKey) {
          currentTransHolder = transFeed.querySelector('[data-seq="' + seqKey + '"]');
        }
        if (!currentTransHolder) {
          currentTransHolder = transFeed.querySelector('.para-item.current.streaming');
        }
        if (!currentTransHolder) {
          var prevTransHolders = transFeed.querySelectorAll('.para-item.current');
          for (var th = 0; th < prevTransHolders.length; th++) {
            prevTransHolders[th].className = prevTransHolders[th].className.replace(/\b(current|streaming)\b/g, '').replace(/\s+/g, ' ') + ' history';
          }
          currentTransHolder = document.createElement('div');
          currentTransHolder.className = 'para-item current streaming translating-placeholder';
          if (seqKey) {
            currentTransHolder.setAttribute('data-seq', seqKey);
          }
          currentTransHolder.textContent = '…';
          transFeed.appendChild(currentTransHolder);
          scrollFeedsToBottom();
        }
      }
    }

    // 2. Translation column
    var rawTransContent = isReplacement ? translatedFull : translatedChunk;
    var isArabicTarget = (targetLang === 'ar' || targetLang === 'ur');
    var isTransCorrupt = rawTransContent && (safeStartsWith(rawTransContent, '[' + targetLang.toUpperCase() + ']') || (!isArabicTarget && isRawArabicLeak(rawTransContent)));
    var transContent = isTransCorrupt ? '' : rawTransContent;

    if (transContent && transContent.length > 0 && transFeed) {
      var currentTrans = null;
      if (seqKey) {
        currentTrans = transFeed.querySelector('[data-seq="' + seqKey + '"]');
      }
      if (!currentTrans) {
        currentTrans = transFeed.querySelector('.para-item.current.streaming');
      }

      if (currentTrans) {
        var isTransFinalized = currentTrans.className.indexOf('streaming') === -1 && currentTrans.className.indexOf('translating-placeholder') === -1;
        if (isTransFinalized && !isFinal) {
          // Stale provisional partial arrived after finalization: ignore to prevent rollback
        } else {
          currentTrans.className = currentTrans.className.replace(/\btranslating-placeholder\b/g, '').replace(/\s+/g, ' ');
          if (isReplacement) {
            currentTrans.textContent = safeTrimStart(transContent);
          } else {
            currentTrans.textContent = safeTrimStart(currentTrans.textContent + transContent);
          }
          if (seqKey && !currentTrans.getAttribute('data-seq')) {
            currentTrans.setAttribute('data-seq', seqKey);
          }
          if (isFinal) {
            currentTrans.className = currentTrans.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
            if (isTvAudioEnabled && currentTrans.textContent && currentTrans.textContent !== '…' && (!seqKey || !spokenSeqs[seqKey])) {
              if (seqKey) spokenSeqs[seqKey] = true;
              playTvBrowserAudio(currentTrans.textContent, targetLang);
            }
          }
        }
      } else {
        var prevsT = transFeed.querySelectorAll('.para-item.current');
        for (var pt = 0; pt < prevsT.length; pt++) {
          prevsT[pt].className = prevsT[pt].className.replace(/\b(current|streaming)\b/g, '').replace(/\s+/g, ' ') + ' history';
        }
        currentTrans = document.createElement('div');
        currentTrans.className = 'para-item current' + (isFinal ? '' : ' streaming');
        if (seqKey) {
          currentTrans.setAttribute('data-seq', seqKey);
        }
        currentTrans.textContent = safeTrimStart(transContent);
        transFeed.appendChild(currentTrans);
        if (isFinal && isTvAudioEnabled && currentTrans.textContent && currentTrans.textContent !== '…' && (!seqKey || !spokenSeqs[seqKey])) {
          if (seqKey) spokenSeqs[seqKey] = true;
          playTvBrowserAudio(currentTrans.textContent, targetLang);
        }
      }

      while (transFeed.children.length > MAX_HISTORY) {
        transFeed.removeChild(transFeed.firstElementChild);
      }
      scrollFeedsToBottom();
    }

    if (isFinal) {
      var finArabic = seqKey && arabicFeed ? arabicFeed.querySelector('[data-seq="' + seqKey + '"]') : (arabicFeed ? arabicFeed.querySelector('.para-item.current.streaming') : null);
      if (finArabic) finArabic.className = finArabic.className.replace(/\bstreaming\b/g, '').replace(/\s+/g, ' ');
      var finTrans = seqKey && transFeed ? transFeed.querySelector('[data-seq="' + seqKey + '"]') : (transFeed ? transFeed.querySelector('.para-item.current.streaming') : null);
      if (finTrans) {
        finTrans.className = finTrans.className.replace(/\b(streaming|translating-placeholder)\b/g, '').replace(/\s+/g, ' ');
        if (isTvAudioEnabled && finTrans.textContent && finTrans.textContent !== '…' && (!seqKey || !spokenSeqs[seqKey])) {
          if (seqKey) spokenSeqs[seqKey] = true;
          playTvBrowserAudio(finTrans.textContent, targetLang);
        }
      }

      var sText = isReplacement ? (originalFull || originalChunk) : (finArabic ? finArabic.textContent : originalChunk);
      var tText = isReplacement ? (translatedFull || translatedChunk) : (finTrans ? finTrans.textContent : translatedChunk);

      if (sText || tText) {
        var item = null;
        if (seq) {
          item = safeFind(recentFeedItems, function (i) { return i.seq === seq; });
        }
        if (!item && timestamp) {
          item = safeFind(recentFeedItems, function (i) { return i.timestamp === timestamp; });
        }
        if (item) {
          if (!item.transObj || typeof item.transObj !== 'object') {
            item.transObj = {};
          }
          if (lang && tText) item.transObj[lang] = tText;
          if (!item.arabicText && sText) item.arabicText = sText;
        } else {
          var newTrans = {};
          newTrans[lang || targetLang] = tText || '';
          recentFeedItems.push({
            seq: seq || (new Date()).getTime(),
            arabicText: sText || '',
            transObj: newTrans,
            timestamp: timestamp || (new Date()).toISOString()
          });
          while (recentFeedItems.length > MAX_HISTORY) recentFeedItems.shift();
        }
      }
    }
  }

  function applyTranscriptsToFeed(transcripts) {
    if (!transcripts || !transcripts.length) return;
    var recent = transcripts.slice(-MAX_HISTORY);
    for (var r = 0; r < recent.length; r++) {
      var t = recent[r];
      var item = null;
      if (t.seq) {
        item = safeFind(recentFeedItems, function (i) { return i.seq === t.seq; });
      }
      if (!item && t.timestamp) {
        item = safeFind(recentFeedItems, function (i) { return i.timestamp === t.timestamp; });
      }
      if (item) {
        item.transObj = safeAssign(item.transObj || {}, t.translations || {});
        if (!item.arabicText && t.arabic) item.arabicText = t.arabic;
      } else {
        recentFeedItems.push({
          seq: t.seq || (new Date()).getTime(),
          arabicText: t.arabic || '',
          transObj: t.translations || {},
          timestamp: t.timestamp
        });
        while (recentFeedItems.length > MAX_HISTORY) recentFeedItems.shift();
      }
    }
    reRenderTranslationFeed();
  }

  function fetchBackfilledHistory(lang) {
    if (!sessionId) return;
    safeAjax('/api/session/' + encodeURIComponent(sessionId) + '/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: lang })
    }, function (err, data) {
      if (!err && data && data.transcripts && data.transcripts.length > 0) {
        applyTranscriptsToFeed(data.transcripts);
      }
    });
  }

  // ─── WEBSOCKET & DUAL-ENGINE WATCHDOG ───
  function startTvHeartbeat() {
    if (tvHeartbeatInterval) clearInterval(tvHeartbeatInterval);
    tvHeartbeatInterval = setInterval(function () {
      if (ws && ws.readyState === 1) { // 1 === OPEN
        try {
          ws.send(JSON.stringify({
            type: 'HEARTBEAT',
            sessionId: sessionId || 'current',
            role: 'tv',
            language: targetLang,
            clientId: tvClientId,
            deviceType: 'computer'
          }));
        } catch (_) {}
      }
      if (sessionId) {
        safeAjax('/api/session/' + encodeURIComponent(sessionId) + '/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: tvClientId,
            role: 'tv',
            language: targetLang,
            deviceType: 'computer'
          })
        }, function () {});
      }
    }, 10000);
  }

  function connectWebSocket() {
    try {
      if (ws && (ws.readyState === 1 || ws.readyState === 0)) {
        return;
      }
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var sidParam = sessionId || 'current';
      var wsUrl = protocol + '//' + window.location.host + '/ws?session=' + encodeURIComponent(sidParam) + '&role=tv&lang=' + encodeURIComponent(targetLang);

      ws = new window.WebSocket(wsUrl);

      ws.onopen = function () {
        lastWsMessageTime = (new Date()).getTime();
        try {
          ws.send(JSON.stringify({
            type: 'JOIN_ROOM',
            sessionId: sessionId || 'current',
            role: 'tv',
            language: targetLang,
            sourceLanguage: sourceLang,
            clientId: tvClientId,
            deviceType: 'computer'
          }));
        } catch (_) {}
        startTvHeartbeat();
      };

      ws.onmessage = function (event) {
        lastWsMessageTime = (new Date()).getTime();
        try {
          var data = JSON.parse(event.data);
          if (!data) return;

          if (data.type === 'SESSION_STATUS') {
            updateTVStatusUI(data.status, data.mosqueName);
          }
          if (data.type === 'SOURCE_LANGUAGE_CHANGED' && data.sourceLang) {
            if (sourceLang !== data.sourceLang) {
              sourceLang = data.sourceLang;
              if (sourceLangSelect) sourceLangSelect.value = sourceLang;
              try { localStorage.setItem('mosq_tv_source_lang', sourceLang); } catch (_) {}
              updateSourceColumnStyling();
            }
          }
          if (data.type === 'JOINED_SUCCESS' && data.session) {
            if (!sessionId && data.sessionId) {
              sessionId = data.sessionId;
            }
            if (data.session.mosqueName) currentMosqueName = data.session.mosqueName;
            if (data.session.sourceLanguage && !getQueryParam('sourceLang')) {
              sourceLang = data.session.sourceLanguage;
              if (sourceLangSelect) sourceLangSelect.value = sourceLang;
              try { localStorage.setItem('mosq_tv_source_lang', sourceLang); } catch (_) {}
              updateSourceColumnStyling();
            }
            if (data.session.tvLanguage && !getQueryParam('lang')) {
              targetLang = data.session.tvLanguage;
              if (targetLangSelect) targetLangSelect.value = targetLang;
              initQRCode();
            }
            if (data.session.tvScreenMode && !getQueryParam('mode')) {
              applyScreenMode(data.session.tvScreenMode);
            }
            if (data.session.tvFontSize) applyTvFontSize(data.session.tvFontSize, data.session.tvCapacity, false);
            if (data.session.tvAudioEnabled !== undefined) setTvAudioState(data.session.tvAudioEnabled);
            if (data.session.tvShowQr !== undefined) setTvQrVisibility(data.session.tvShowQr);
          }
          if (data.type === 'TV_SETTINGS_UPDATE') {
            if (data.tvFontSize) applyTvFontSize(data.tvFontSize, data.tvCapacity, true);
            if (data.tvAudioEnabled !== undefined) setTvAudioState(data.tvAudioEnabled);
            if (data.tvShowQr !== undefined) setTvQrVisibility(data.tvShowQr);
            if (data.tvScreenMode) applyScreenMode(data.tvScreenMode);
            if (data.sourceLanguage || data.sourceLang) {
              var newSource = data.sourceLanguage || data.sourceLang;
              if (sourceLang !== newSource) {
                sourceLang = newSource;
                if (sourceLangSelect) sourceLangSelect.value = sourceLang;
                try { localStorage.setItem('mosq_tv_source_lang', sourceLang); } catch (_) {}
                updateSourceColumnStyling();
              }
            }
            if (data.tvTargetLang && safeIncludes(VALID_LANGS, data.tvTargetLang)) {
              if (targetLang !== data.tvTargetLang) {
                targetLang = data.tvTargetLang;
                if (targetLangSelect) targetLangSelect.value = targetLang;
                try { localStorage.setItem('mosq_tv_lang', targetLang); } catch (_) {}
                initQRCode();
                reRenderTranslationFeed();
                fetchBackfilledHistory(targetLang);
                if (ws && ws.readyState === 1) {
                  try {
                    ws.send(JSON.stringify({
                      type: 'CHANGE_LANGUAGE',
                      language: targetLang,
                      role: 'tv',
                      sessionId: sessionId || 'current'
                    }));
                  } catch (_) {}
                }
              }
            }
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
          if (data.type === 'SESSION_HISTORY_BACKFILL') {
            if (data.lang && data.lang !== targetLang) return;
            if (data.transcripts) {
              applyTranscriptsToFeed(data.transcripts);
            }
          }
          if (data.type === 'STREAMING_TOKEN') {
            if (data.timestamp) seenKeys[data.timestamp] = true;
            if (data.seq) {
              seenKeys['seq_' + data.seq] = true;
              if (data.seq > lastSeqReceived) lastSeqReceived = data.seq;
            }
            handleStreamingToken(data);
          }
          if (data.type === 'LIVE_SUBTITLE') {
            var key = data.seq ? ('seq_' + data.seq) : data.timestamp;
            if (key) seenKeys[key] = true;
            if (data.seq && data.seq > lastSeqReceived) lastSeqReceived = data.seq;
            handleIncomingSpeech(data, true);
          }
        } catch (_) {}
      };

      ws.onclose = function () {
        setTimeout(connectWebSocket, 2500);
      };

      ws.onerror = function () {
        try { ws.close(); } catch (_) {}
      };
    } catch (e) {
      // WebSocket creation failure on legacy platforms - polling engine continues independently
      setTimeout(connectWebSocket, 5000);
    }
  }

  // ─── HTTP FEED POLLING ENGINE (INDEPENDENT WITH WATCHDOG) ───
  function startFeedSync() {
    if (feedSyncInterval) clearInterval(feedSyncInterval);

    feedSyncInterval = setInterval(function () {
      var url = '';
      if (sessionId) {
        url = '/api/session/' + encodeURIComponent(sessionId) + '/feed?since_seq=' + lastSeqReceived;
      } else {
        url = '/api/session/current/feed?since_seq=' + lastSeqReceived;
      }

      safeAjax(url, { method: 'GET' }, function (err, data) {
        if (err || !data) return;

        if (data.sessionId && !sessionId) {
          sessionId = data.sessionId;
          initQRCode();
        }

        if (data.status) {
          updateTVStatusUI(data.status, data.mosqueName);
        }
        if (data.tvScreenMode && !getQueryParam('mode')) {
          applyScreenMode(data.tvScreenMode);
        }
        if (data.tvLanguage && safeIncludes(VALID_LANGS, data.tvLanguage) && !getQueryParam('lang')) {
          if (targetLang !== data.tvLanguage) {
            targetLang = data.tvLanguage;
            if (targetLangSelect) targetLangSelect.value = targetLang;
            try { localStorage.setItem('mosq_tv_lang', targetLang); } catch (_) {}
            initQRCode();
            reRenderTranslationFeed();
          }
        }
        if (data.sourceLanguage && safeIncludes(VALID_SOURCE_LANGS, data.sourceLanguage) && !getQueryParam('sourceLang')) {
          if (sourceLang !== data.sourceLanguage) {
            sourceLang = data.sourceLanguage;
            if (sourceLangSelect) sourceLangSelect.value = sourceLang;
            try { localStorage.setItem('mosq_tv_source_lang', sourceLang); } catch (_) {}
            updateSourceColumnStyling();
          }
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

        if (data.transcripts && data.transcripts.length === 0 && recentFeedItems.length > 0 && data.status === 'idle') {
          clearTvFeeds();
        }

        if (data.transcripts && data.transcripts.length > 0) {
          // LIVENESS WATCHDOG:
          // If WS is not OPEN or has received no messages for >8s, allow HTTP polling to render immediately
          var now = (new Date()).getTime();
          var isWsDegraded = (!ws || ws.readyState !== 1 || (now - lastWsMessageTime > 8000));

          if (isWsDegraded) {
            for (var i = 0; i < data.transcripts.length; i++) {
              var item = data.transcripts[i];
              var k = item.seq ? ('seq_' + item.seq) : item.timestamp;
              if (k && !seenKeys[k]) {
                seenKeys[k] = true;
                if (item.seq && item.seq > lastSeqReceived) lastSeqReceived = item.seq;
                handleIncomingSpeech({
                  seq: item.seq,
                  arabic: item.arabic,
                  translations: item.translations,
                  translated: (item.translations && item.translations[targetLang]) || '',
                  ayah: item.ayah,
                  timestamp: item.timestamp
                }, true);
              }
            }
          } else {
            // WS is active: keep lastSeqReceived updated to prevent duplicate polling history
            for (var j = 0; j < data.transcripts.length; j++) {
              var it = data.transcripts[j];
              var sKey = it.seq ? ('seq_' + it.seq) : it.timestamp;
              if (sKey) seenKeys[sKey] = true;
              if (it.seq && it.seq > lastSeqReceived) lastSeqReceived = it.seq;
            }
          }
        }
      });
    }, 2000);
  }

  // ─── AUTO-DISCOVERY ENGINE ───
  function pollActiveSessionAutoDiscovery() {
    safeAjax('/api/session/current', { method: 'GET' }, function (err, data) {
      if (err || !data) return;

      if (data.mosqueName) currentMosqueName = data.mosqueName;
      if (mosqueNameEl) mosqueNameEl.textContent = currentMosqueName;

      if (data.status === 'active' || data.isLive) {
        if (autoDiscoverInterval) {
          clearInterval(autoDiscoverInterval);
          autoDiscoverInterval = null;
        }
        sessionId = data.sessionId || data.id;
        isAutoDiscovering = false;
        initSession();
      } else {
        updateTVStatusUI(data.status || 'idle', data.mosqueName);
      }
    });
  }

  // ─── INITIALIZATION ───
  function initSession() {
    initDomReferences();
    initQRCode();
    updateSourceColumnStyling();
    applyScreenMode(screenMode);

    // Restore font size from storage
    try {
      var savedSize = localStorage.getItem('mosq_tv_font_size');
      var savedCap = localStorage.getItem('mosq_tv_capacity');
      if (savedSize) applyTvFontSize(savedSize, savedCap, false);
    } catch (_) {}

    var sessionUrl = sessionId ? ('/api/session/' + encodeURIComponent(sessionId)) : '/api/session/current';

    safeAjax(sessionUrl, { method: 'GET' }, function (err, data) {
      if (!err && data) {
        if (!sessionId && (data.sessionId || data.id)) {
          sessionId = data.sessionId || data.id;
        }
        if (data.mosqueName) currentMosqueName = data.mosqueName;
        updateTVStatusUI(data.status, data.mosqueName);

        if (data.tvFontSize) applyTvFontSize(data.tvFontSize, data.tvCapacity, false);
        if (data.tvAudioEnabled !== undefined) setTvAudioState(data.tvAudioEnabled);
        if (data.tvShowQr !== undefined) setTvQrVisibility(data.tvShowQr);
        if (data.tvScreenMode) applyScreenMode(data.tvScreenMode);

        if (data.sourceLanguage) {
          sourceLang = data.sourceLanguage;
          try { localStorage.setItem('mosq_tv_source_lang', sourceLang); } catch (_) {}
          updateSourceColumnStyling();
        }

        var sessionTvLang = data.tvLanguage || data.primaryLanguage;
        if (sessionTvLang && safeIncludes(VALID_LANGS, sessionTvLang) && !getQueryParam('lang')) {
          targetLang = sessionTvLang;
          if (targetLangSelect) targetLangSelect.value = targetLang;
          initQRCode();
        }

        // Restore history on page refresh
        if (data.transcripts && data.transcripts.length > 0) {
          var recent = data.transcripts.slice(-MAX_HISTORY);
          if (arabicFeed) arabicFeed.innerHTML = '';
          if (transFeed) transFeed.innerHTML = '';
          recentFeedItems.length = 0;
          for (var i = 0; i < recent.length; i++) {
            var item = recent[i];
            if (item.timestamp) seenKeys[item.timestamp] = true;
            if (item.seq) {
              seenKeys['seq_' + item.seq] = true;
              if (item.seq > lastSeqReceived) lastSeqReceived = item.seq;
            }
            var transObj = item.translations || (typeof item.translated === 'string' ? { en: item.translated } : item.translated);
            appendToFeed(item.arabic, transObj, false);
          }
        }

        // If session was discovered but is not live, poll for live start
        if (isAutoDiscovering && (data.status !== 'active' && !data.isLive)) {
          if (!autoDiscoverInterval) {
            autoDiscoverInterval = setInterval(pollActiveSessionAutoDiscovery, 3000);
          }
        }
      } else if (isAutoDiscovering) {
        if (!autoDiscoverInterval) {
          autoDiscoverInterval = setInterval(pollActiveSessionAutoDiscovery, 3000);
        }
      }

      // Start dual engine independently
      connectWebSocket();
      startFeedSync();
    });
  }

  // ─── FULLSCREEN CONTROLS (VENDOR PREFIXED FOR SMART TVS) ───
  window.toggleFullscreen = function () {
    var doc = document;
    var docEl = doc.documentElement;
    var isFs = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;

    if (!isFs) {
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen().catch(function () {});
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        docEl.msRequestFullscreen();
      }
      if (btnFullscreen) btnFullscreen.textContent = '⛶ Exit Fullscreen';
    } else {
      if (doc.exitFullscreen) {
        doc.exitFullscreen().catch(function () {});
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (doc.mozCancelFullScreen) {
        doc.mozCancelFullScreen();
      } else if (doc.msExitFullscreen) {
        doc.msExitFullscreen();
      }
      if (btnFullscreen) btnFullscreen.textContent = '⛶ Fullscreen';
    }
  };

  // ─── ATTACH DOM LISTENERS ───
  function attachEventHandlers() {
    if (sourceLangSelect) {
      sourceLangSelect.value = sourceLang;
      sourceLangSelect.addEventListener('change', function () {
        sourceLang = sourceLangSelect.value;
        try { localStorage.setItem('mosq_tv_source_lang', sourceLang); } catch (_) {}
        updateSourceColumnStyling();
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({
              type: 'SET_SOURCE_LANGUAGE',
              sessionId: sessionId || 'current',
              sourceLang: sourceLang
            }));
          } catch (_) {}
        }
      });
    }

    if (targetLangSelect) {
      targetLangSelect.value = targetLang;
      targetLangSelect.addEventListener('change', function () {
        targetLang = targetLangSelect.value;
        userExplicitlySelectedLang = true;
        try { localStorage.setItem('mosq_tv_lang', targetLang); } catch (_) {}
        initQRCode();
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({
              type: 'CHANGE_LANGUAGE',
              sessionId: sessionId || 'current',
              language: targetLang
            }));
          } catch (_) {}
        }
        reRenderTranslationFeed();
        fetchBackfilledHistory(targetLang);
      });
    }

    if (screenModeSelect) {
      screenModeSelect.value = screenMode;
      screenModeSelect.addEventListener('change', function () {
        applyScreenMode(screenModeSelect.value);
      });
    }
  }

  // ─── STARTUP LIFECYCLE ───
  function onReady() {
    initDomReferences();
    attachEventHandlers();
    initSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  if (typeof window !== 'undefined') {
    window.__tvDisplayTest = {
      handleStreamingToken: handleStreamingToken,
      handleIncomingSpeech: handleIncomingSpeech,
      getValidTranslationText: getValidTranslationText,
      reRenderTranslationFeed: reRenderTranslationFeed
    };
  }
})();
