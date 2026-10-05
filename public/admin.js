// MosqAI - Multi-Mosque Management & Pulpit Console Script
const urlParams = new URLSearchParams(window.location.search);
let currentSessionId = urlParams.get('session') || null;

let ws = null;
let sessionStatus = 'idle';
let sessionStartTime = null;
let timerInterval = null;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let micInterval = null;
let micActive = false;
let speechRecognition = null;
let isSimulating = false;

// DOM Views
const viewSessionsList = document.getElementById('view-sessions-list');
const viewSessionConsole = document.getElementById('view-session-console');
const sessionsGridContainer = document.getElementById('sessions-grid-container');
const btnNavSessions = document.getElementById('btn-nav-sessions');
const btnOpenCreateModal = document.getElementById('btn-open-create-modal');
const modalCreateSession = document.getElementById('modal-create-session');
const btnCloseCreateModal = document.getElementById('btn-close-create-modal');
const btnCancelCreate = document.getElementById('btn-cancel-create');
const btnSubmitCreate = document.getElementById('btn-submit-create');
const newMosqueNameInput = document.getElementById('new-mosque-name');
const newSessionIdInput = document.getElementById('new-session-id');
const newPrimaryLangSelect = document.getElementById('new-primary-lang');

// Lock Banner & Console Controls
const lockBanner = document.getElementById('lock-banner');
const lockBannerIcon = document.getElementById('lock-banner-icon');
const lockBannerText = document.getElementById('lock-banner-text');
const mosqueTitle = document.getElementById('mosque-title');
const mosqueSubtitle = document.getElementById('mosque-subtitle');
const sessionBadge = document.getElementById('session-badge');
const sessionStatusText = document.getElementById('session-status-text');
const headerBtnTv = document.getElementById('header-btn-tv');
const liveTimer = document.getElementById('live-timer');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnEnd = document.getElementById('btn-end');
const btnSimulate = document.getElementById('btn-simulate');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const micLevelBar = document.getElementById('mic-level-bar');
const manualInput = document.getElementById('manual-input');
const btnInject = document.getElementById('btn-inject');

// Stats & Links
const statAttendees = document.getElementById('stat-attendees');
const statDisplays = document.getElementById('stat-displays');
const languagesBreakdown = document.getElementById('languages-breakdown');
const qrCodeImg = document.getElementById('qr-code-img');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnOpenJoin = document.getElementById('btn-open-join');
const btnOpenTvSide = document.getElementById('btn-open-tv-side');
const transcriptFeed = document.getElementById('transcript-feed');
const transCount = document.getElementById('trans-count');

// Auth elements
const authModal = document.getElementById('auth-modal');
const adminPinInput = document.getElementById('admin-pin-input');
const btnSubmitAuth = document.getElementById('btn-submit-auth');
const authErrorMsg = document.getElementById('auth-error-msg');
const btnLogout = document.getElementById('btn-logout');

// QR Preview Modal elements
const modalQrPreview = document.getElementById('modal-qr-preview');
const btnCloseQrModal = document.getElementById('btn-close-qr-modal');
const qrModalMosqueName = document.getElementById('qr-modal-mosque-name');
const qrModalImg = document.getElementById('qr-modal-img');
const qrModalLinkText = document.getElementById('qr-modal-link-text');
const btnCopyQrModalLink = document.getElementById('btn-copy-qr-modal-link');
const btnOpenQrModalLink = document.getElementById('btn-open-qr-modal-link');

// Speaker / Microphone Language elements
const speakerLangSelect = document.getElementById('speaker-lang-select');

// Session History Modal elements
const btnHeaderHistory = document.getElementById('btn-header-history');
const modalSessionHistory = document.getElementById('modal-session-history');
const btnCloseHistModal = document.getElementById('btn-close-hist-modal');
const histModalSubtitle = document.getElementById('hist-modal-subtitle');
const histModalBody = document.getElementById('hist-modal-body');
const btnArchiveCurrentNow = document.getElementById('btn-archive-current-now');

let transcriptItemsCount = 0;

// ─── AUTHENTICATION ───
async function checkAuth() {
  const token = localStorage.getItem('mosq_admin_token');
  if (!token) {
    showAuthModal();
    return false;
  }
  try {
    const res = await fetch('/api/auth/verify', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      hideAuthModal();
      return true;
    }
  } catch (e) {}
  showAuthModal();
  return false;
}

function showAuthModal() {
  if (authModal) authModal.style.display = 'flex';
  if (adminPinInput) setTimeout(() => adminPinInput.focus(), 100);
}

function hideAuthModal() {
  if (authModal) authModal.style.display = 'none';
  if (authErrorMsg) authErrorMsg.style.display = 'none';
}

if (btnSubmitAuth) {
  btnSubmitAuth.addEventListener('click', async () => {
    const pin = adminPinInput ? adminPinInput.value : '';
    if (!pin) {
      authErrorMsg.textContent = 'Please enter the Imam Passcode.';
      authErrorMsg.style.display = 'block';
      return;
    }
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('mosq_admin_token', data.token);
        hideAuthModal();
        init();
      } else {
        authErrorMsg.textContent = data.error || 'Incorrect passcode. Default is: mosq2026';
        authErrorMsg.style.display = 'block';
      }
    } catch (e) {
      authErrorMsg.textContent = 'Connection error: ' + e.message;
      authErrorMsg.style.display = 'block';
    }
  });
}

if (adminPinInput) {
  adminPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnSubmitAuth.click();
    }
  });
}

if (btnLogout) {
  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('mosq_admin_token');
    showAuthModal();
  });
}

// ─── SESSIONS VIEW SWITCHER ───
function setupViewRouting() {
  if (!currentSessionId) {
    // Show Sessions Management View
    if (viewSessionsList) viewSessionsList.style.display = 'block';
    if (viewSessionConsole) viewSessionConsole.style.display = 'none';
    if (btnNavSessions) btnNavSessions.style.display = 'none';
    mosqueTitle.textContent = 'MosqAI — Mosque Sessions';
    mosqueSubtitle.textContent = 'Multi-Mosque Live Khutbah Manager';
    loadAllSessionsList();
  } else {
    // Show Console View for specific session
    if (viewSessionsList) viewSessionsList.style.display = 'none';
    if (viewSessionConsole) viewSessionConsole.style.display = 'block';
    if (btnNavSessions) {
      btnNavSessions.style.display = 'inline-flex';
      btnNavSessions.onclick = () => {
        window.location.href = '/admin.html';
      };
    }
    initConsoleSession(currentSessionId);
  }
}

// Load and Render All Mosque Sessions
async function loadAllSessionsList() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const sessions = await res.json();

    sessionsGridContainer.innerHTML = '';
    sessions.forEach(sess => {
      const stats = sess.stats || { totalAttendees: 0, totalTVDisplays: 0 };
      const card = document.createElement('div');
      card.className = `session-card-item ${sess.status === 'active' ? 'active' : ''}`;

      const statusMap = {
        active: { class: 'active', text: '● LIVE' },
        paused: { class: 'paused', text: '⏸ PAUSED' },
        idle: { class: 'idle', text: '⏳ WAITING / IDLE' },
        ended: { class: 'ended', text: '⏹ CONCLUDED' }
      };
      const badgeInfo = statusMap[sess.status] || statusMap.idle;

      card.innerHTML = `
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
            <h3 style="font-size: 1.15rem; font-weight: 700; color: #fff;">${sess.mosqueName}</h3>
            <span class="badge-status ${badgeInfo.class}">${badgeInfo.text}</span>
          </div>
          <div style="font-size: 0.8rem; color: #94a3b8; font-family: monospace; margin-bottom: 0.75rem;">
            ID: ${sess.id}
          </div>
          <div style="display: flex; gap: 1rem; font-size: 0.82rem; color: var(--text-secondary);">
            <span>👥 <strong>${stats.totalAttendees}</strong> Listeners</span>
            <span>📺 <strong>${stats.totalTVDisplays}</strong> TV Screen</span>
          </div>
        </div>

        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem;">
          <a href="/admin.html?session=${encodeURIComponent(sess.id)}" class="btn btn-primary" style="flex: 1 1 100%; text-align: center; font-size: 0.84rem; padding: 0.48rem;">
            🎙️ Open Pulpit Console →
          </a>
          <button type="button" class="btn btn-secondary btn-show-session-history" data-session-id="${sess.id}" data-mosque-name="${sess.mosqueName}" style="flex: 1 1 100%; font-size: 0.82rem; padding: 0.45rem; display: flex; align-items: center; justify-content: center; gap: 0.35rem; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); color: #7dd3fc; cursor: pointer; transition: all 0.2s;">
            📜 View Session History ${sess.historyCount !== undefined ? `(${sess.historyCount} ${sess.historyCount === 1 ? 'Run' : 'Runs'})` : ''}
          </button>
          <button type="button" class="btn btn-secondary btn-show-session-qr" data-session-id="${sess.id}" data-mosque-name="${sess.mosqueName}" data-lang="${sess.primaryLanguage || 'en'}" style="flex: 1; font-size: 0.82rem; padding: 0.45rem;">
            📱 Show QR Code
          </button>
          <a href="/display.html?session=${encodeURIComponent(sess.id)}" target="_blank" class="btn btn-secondary" style="flex: 1; font-size: 0.82rem; padding: 0.45rem;">
            📺 TV Display ↗
          </a>
          <button type="button" class="btn btn-danger btn-delete-session" data-session-id="${sess.id}" data-mosque-name="${sess.mosqueName}" style="flex: 1 1 100%; font-size: 0.8rem; padding: 0.42rem; display: flex; align-items: center; justify-content: center; gap: 0.35rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #fca5a5; cursor: pointer; transition: all 0.2s;">
            🗑️ Delete Session
          </button>
        </div>
      `;
      sessionsGridContainer.appendChild(card);
    });

    // Wire up Session History buttons on cards
    document.querySelectorAll('.btn-show-session-history').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sid = e.currentTarget.getAttribute('data-session-id');
        const mname = e.currentTarget.getAttribute('data-mosque-name') || sid;
        openSessionHistoryModal(sid, mname);
      });
    });

    // Wire up QR Code preview buttons
    document.querySelectorAll('.btn-show-session-qr').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sid = e.currentTarget.getAttribute('data-session-id');
        const mname = e.currentTarget.getAttribute('data-mosque-name');
        const lang = e.currentTarget.getAttribute('data-lang') || 'en';
        openQrModal(sid, mname, lang);
      });
    });

    // Wire up Delete Session buttons
    document.querySelectorAll('.btn-delete-session').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const sid = e.currentTarget.getAttribute('data-session-id');
        const mname = e.currentTarget.getAttribute('data-mosque-name') || sid;
        const ok = confirm(`Are you sure you want to permanently delete session "${mname}" (${sid})?\nThis cannot be undone.`);
        if (!ok) return;

        try {
          const res = await fetch(`/api/session/${encodeURIComponent(sid)}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            await loadAllSessionsList();
          } else {
            alert('Failed to delete session. Please try again.');
          }
        } catch (err) {
          console.warn('Error deleting session:', err);
          alert('Error deleting session: ' + err.message);
        }
      });
    });
  } catch (err) {
    console.warn('Failed loading sessions:', err.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function openSessionHistoryModal(sessionId, mosqueName) {
  if (!modalSessionHistory) return;
  modalSessionHistory.style.display = 'flex';

  const mName = mosqueName || sessionId;
  if (histModalSubtitle) {
    histModalSubtitle.innerHTML = `Mosque: <strong style="color: #fff;">${escapeHtml(mName)}</strong> • Session: <code style="color: #38bdf8;">${escapeHtml(sessionId)}</code>`;
  }
  if (btnArchiveCurrentNow) {
    btnArchiveCurrentNow.dataset.sessionId = sessionId;
  }
  if (histModalBody) {
    histModalBody.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: #94a3b8;">
        <div style="font-size: 2rem; margin-bottom: 0.5rem; animation: pulse 1.5s infinite;">📜</div>
        <p>Loading session history records...</p>
      </div>
    `;
  }

  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/history`);
    if (!res.ok) {
      if (histModalBody) histModalBody.innerHTML = `<div style="text-align: center; padding: 2rem; color: #fca5a5;">Failed loading history. Status: ${res.status}</div>`;
      return;
    }
    const rawData = await res.json();
    const runs = Array.isArray(rawData) ? rawData : (rawData.history || []);

    if (!runs || runs.length === 0) {
      if (histModalBody) {
        histModalBody.innerHTML = `
          <div style="text-align: center; padding: 3.5rem 1.5rem; background: rgba(30, 41, 59, 0.4); border: 1px dashed rgba(255,255,255,0.12); border-radius: 12px;">
            <div style="font-size: 2.75rem; margin-bottom: 0.75rem;">📅</div>
            <h4 style="font-size: 1.1rem; color: #f8fafc; margin-bottom: 0.5rem;">No Archived Runs Yet</h4>
            <p style="font-size: 0.88rem; color: #94a3b8; max-width: 520px; margin: 0 auto 1.5rem; line-height: 1.6;">
              When sermons are delivered across multiple days or prayer sessions, every khutbah's complete transcript, duration, attendance, and translations (tailored to your Display TV) are automatically archived here.
            </p>
            <p style="font-size: 0.8rem; color: #64748b;">
              💡 Tip: Click <strong>"📥 Archive Current Run Now"</strong> above to snapshot current speech immediately.
            </p>
          </div>
        `;
      }
      return;
    }

    // Render runs
    let html = `
      <div style="margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.85rem; color: #94a3b8;">Found <strong style="color: #38bdf8;">${runs.length}</strong> recorded sermon ${runs.length === 1 ? 'run' : 'runs'}:</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 1.25rem;">
    `;

    runs.forEach((run, index) => {
      const tvLangUpper = (run.tvLanguage || 'en').toUpperCase();

      html += `
        <div class="history-run-card" style="background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.3);">
          <!-- Header Bar -->
          <div style="padding: 1rem 1.25rem; background: rgba(30, 41, 59, 0.6); border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.75rem;">
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem;">
                <span style="background: #38bdf8; font-weight: 800; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.35); color: #7dd3fc;">
                  #${runs.length - index}
                </span>
                <h4 style="font-size: 1.05rem; font-weight: 700; color: #f8fafc; margin: 0;">
                  📅 ${escapeHtml(run.dateDisplay)}
                </h4>
                <span style="font-size: 0.85rem; color: #94a3b8; margin-left: 0.25rem;">
                  🕒 ${escapeHtml(run.timeDisplay)}
                </span>
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.8rem; color: #cbd5e1;">
                <span>⏱️ Duration: <strong>${escapeHtml(run.durationDisplay)}</strong></span>
                <span>👥 Attendance: <strong>${run.totalAttendance}</strong> <span style="color: #64748b;">(📱 ${run.phoneAttendees} Phone, 📺 ${run.computerDisplays} TV)</span></span>
                <span>📺 TV Language: <strong style="color: #10b981;">${tvLangUpper}</strong></span>
                <span>🗣️ <strong>${run.totalTranscripts}</strong> Lines</span>
              </div>
            </div>

            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <button type="button" class="btn btn-secondary btn-copy-run-transcript" data-run-id="${run.id}" style="font-size: 0.78rem; padding: 0.35rem 0.65rem; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2);">
                📋 Copy Transcript
              </button>
              <button type="button" class="btn btn-danger btn-delete-run" data-run-id="${run.id}" data-session-id="${sessionId}" style="font-size: 0.78rem; padding: 0.35rem 0.65rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #fca5a5;">
                🗑️ Delete
              </button>
            </div>
          </div>

          <!-- Transcript Lines Container -->
          <div style="padding: 1rem 1.25rem; max-height: 280px; overflow-y: auto;">
      `;

      if (!run.transcripts || run.transcripts.length === 0) {
        html += `<div style="font-size: 0.84rem; color: #64748b; font-style: italic;">No speech lines recorded for this run.</div>`;
      } else {
        html += `<div style="display: flex; flex-direction: column; gap: 0.75rem;">`;
        run.transcripts.forEach((t, tIdx) => {
          const origRtl = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(t.original);
          const transRtl = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(t.translation);
          const timeStr = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

          html += `
            <div style="padding: 0.6rem 0.8rem; background: rgba(255,255,255,0.025); border-left: 3px solid #38bdf8; border-radius: 4px;">
              <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: #64748b; margin-bottom: 0.25rem;">
                <span>Line #${tIdx + 1}</span>
                <span>${timeStr}</span>
              </div>
              <div style="font-size: 0.96rem; color: #e2e8f0; line-height: 1.5; direction: ${origRtl ? 'rtl' : 'ltr'}; text-align: ${origRtl ? 'right' : 'left'}; font-family: ${origRtl ? 'var(--font-arabic)' : 'inherit'};">
                <span style="font-size: 0.75rem; color: #94a3b8; font-weight: 600; display: inline-block; margin-right: 0.4rem;">🗣️ Spoken:</span>${escapeHtml(t.original)}
              </div>
              <div style="font-size: 0.92rem; color: #34d399; margin-top: 0.35rem; line-height: 1.5; direction: ${transRtl ? 'rtl' : 'ltr'}; text-align: ${transRtl ? 'right' : 'left'}; font-family: ${transRtl ? 'var(--font-arabic)' : 'inherit'};">
                <span style="font-size: 0.75rem; color: #10b981; font-weight: 600; display: inline-block; margin-right: 0.4rem;">📺 TV [${tvLangUpper}]:</span>${escapeHtml(t.translation || '(no translation)')}
              </div>
            </div>
          `;
        });
        html += `</div>`;
      }

      html += `
          </div>
        </div>
      `;
    });

    html += `</div>`;
    if (histModalBody) histModalBody.innerHTML = html;

    // Wire Copy buttons
    document.querySelectorAll('.btn-copy-run-transcript').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const runId = e.currentTarget.getAttribute('data-run-id');
        const targetRun = runs.find(r => r.id === runId);
        if (!targetRun || !targetRun.transcripts) return;

        const textContent = targetRun.transcripts.map((t, idx) => {
          const time = t.timestamp ? `[${new Date(t.timestamp).toLocaleTimeString()}] ` : '';
          return `${idx + 1}. ${time}\nSpoken: ${t.original}\nTV [${(targetRun.tvLanguage || 'en').toUpperCase()}]: ${t.translation}\n`;
        }).join('\n');

        const headerInfo = `=== MosqAI Khutbah Transcript ===\nMosque: ${targetRun.mosqueName}\nDate: ${targetRun.dateDisplay} ${targetRun.timeDisplay}\nDuration: ${targetRun.durationDisplay}\nAttendance: ${targetRun.totalAttendance} listeners\nDisplay TV Language: ${(targetRun.tvLanguage || 'en').toUpperCase()}\n\n`;

        navigator.clipboard.writeText(headerInfo + textContent).then(() => {
          const orig = e.currentTarget.textContent;
          e.currentTarget.textContent = '✅ Copied!';
          setTimeout(() => e.currentTarget.textContent = orig, 2000);
        });
      });
    });

    // Wire Delete Run buttons
    document.querySelectorAll('.btn-delete-run').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const runId = e.currentTarget.getAttribute('data-run-id');
        const sid = e.currentTarget.getAttribute('data-session-id');
        const ok = confirm('Delete this khutbah run from history?');
        if (!ok) return;

        try {
          const delRes = await fetch(`/api/session/${encodeURIComponent(sid)}/history/${encodeURIComponent(runId)}`, {
            method: 'DELETE'
          });
          if (delRes.ok) {
            openSessionHistoryModal(sid, mosqueName);
            loadAllSessionsList(); // update run count on cards
          } else {
            alert('Failed to delete history run.');
          }
        } catch (err) {
          alert('Delete error: ' + err.message);
        }
      });
    });

  } catch (err) {
    if (histModalBody) {
      histModalBody.innerHTML = `<div style="text-align: center; padding: 2rem; color: #fca5a5;">Error loading history: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function openQrModal(sessionId, mosqueName, lang = 'en') {
  const joinUrl = `${window.location.origin}/join.html?session=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(lang)}`;
  if (qrModalMosqueName) qrModalMosqueName.textContent = mosqueName || sessionId;
  if (qrModalImg) {
    qrModalImg.src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
    qrModalImg.onerror = () => {
      qrModalImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(joinUrl)}`;
    };
  }
  if (qrModalLinkText) qrModalLinkText.textContent = joinUrl;
  if (btnOpenQrModalLink) btnOpenQrModalLink.href = joinUrl;
  if (btnCopyQrModalLink) {
    btnCopyQrModalLink.onclick = () => {
      navigator.clipboard.writeText(joinUrl).then(() => {
        btnCopyQrModalLink.textContent = '✅ Copied!';
        setTimeout(() => btnCopyQrModalLink.textContent = '📋 Copy Link', 2000);
      });
    };
  }
  if (modalQrPreview) modalQrPreview.style.display = 'flex';
}

if (btnCloseQrModal) {
  btnCloseQrModal.addEventListener('click', () => {
    if (modalQrPreview) modalQrPreview.style.display = 'none';
  });
}

// Session History Modal Listeners
if (btnCloseHistModal) {
  btnCloseHistModal.addEventListener('click', () => {
    if (modalSessionHistory) modalSessionHistory.style.display = 'none';
  });
}

if (btnHeaderHistory) {
  btnHeaderHistory.addEventListener('click', () => {
    if (!currentSessionId) return;
    const mName = mosqueTitle ? mosqueTitle.textContent.replace(' — Pulpit Console', '').trim() : currentSessionId;
    openSessionHistoryModal(currentSessionId, mName);
  });
}

if (btnArchiveCurrentNow) {
  btnArchiveCurrentNow.addEventListener('click', async () => {
    const sid = btnArchiveCurrentNow.dataset.sessionId || currentSessionId;
    if (!sid) return;
    try {
      btnArchiveCurrentNow.disabled = true;
      btnArchiveCurrentNow.textContent = 'Archiving...';
      const res = await fetch(`/api/session/${encodeURIComponent(sid)}/archive-current`, {
        method: 'POST'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const mName = mosqueTitle ? mosqueTitle.textContent.replace(' — Pulpit Console', '').trim() : sid;
        await openSessionHistoryModal(sid, mName);
        if (typeof loadAllSessionsList === 'function') loadAllSessionsList();
      } else {
        alert(data.error || 'No active speech to archive in this session yet.');
      }
    } catch (err) {
      alert('Error archiving session: ' + err.message);
    } finally {
      btnArchiveCurrentNow.disabled = false;
      btnArchiveCurrentNow.textContent = '📥 Archive Current Run Now';
    }
  });
}

// ─── UNIVERSAL SPEAKER LANGUAGE LOGIC ───
function getWebSpeechLang(code) {
  const map = {
    auto: (navigator.language || 'en-US'),
    ar: 'ar-SA',
    en: 'en-US',
    bn: 'bn-BD',
    ur: 'ur-PK',
    tr: 'tr-TR',
    fr: 'fr-FR',
    'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW',
    id: 'id-ID',
    ms: 'ms-MY',
    ru: 'ru-RU',
    de: 'de-DE',
    es: 'es-ES'
  };
  return map[code] || (navigator.language || 'en-US');
}

if (speakerLangSelect) {
  speakerLangSelect.addEventListener('change', () => {
    const lang = speakerLangSelect.value;
    try { localStorage.setItem('mosq_speaker_lang', lang); } catch (e) {}

    if (speechRecognition && micActive) {
      speechRecognition.lang = getWebSpeechLang(lang);
    }

    if (currentSessionId) {
      fetch(`/api/session/${encodeURIComponent(currentSessionId)}/speaker-language`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang })
      }).catch(() => {});

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'SET_SPEAKER_LANGUAGE',
          sessionId: currentSessionId,
          language: lang
        }));
      }
    }
  });
}

// Create New Session Modal Logic
if (btnOpenCreateModal) {
  btnOpenCreateModal.addEventListener('click', () => {
    modalCreateSession.style.display = 'flex';
    newMosqueNameInput.value = '';
    newSessionIdInput.value = '';
    newMosqueNameInput.focus();
  });
}

if (btnCloseCreateModal) btnCloseCreateModal.addEventListener('click', () => modalCreateSession.style.display = 'none');
if (btnCancelCreate) btnCancelCreate.addEventListener('click', () => modalCreateSession.style.display = 'none');

if (newMosqueNameInput) {
  newMosqueNameInput.addEventListener('input', () => {
    // Auto-slugify mosque name with secure random suffix
    const slug = newMosqueNameInput.value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '');
    if (slug) {
      if (!newSessionIdInput.dataset.token) {
        newSessionIdInput.dataset.token = Math.random().toString(36).substring(2, 8);
      }
      newSessionIdInput.value = `${slug}-${newSessionIdInput.dataset.token}`;
    } else {
      newSessionIdInput.value = '';
      delete newSessionIdInput.dataset.token;
    }
  });
}

if (btnOpenCreateModal) {
  btnOpenCreateModal.addEventListener('click', () => {
    modalCreateSession.style.display = 'flex';
    newMosqueNameInput.value = '';
    if (newSessionIdInput) {
      delete newSessionIdInput.dataset.token;
      newSessionIdInput.value = '';
    }
    newMosqueNameInput.focus();
  });
}

if (btnSubmitCreate) {
  btnSubmitCreate.addEventListener('click', async () => {
    const mosqueName = newMosqueNameInput.value.trim();
    const sessionId = newSessionIdInput.value.trim();
    const primaryLanguage = newPrimaryLangSelect.value;

    if (!mosqueName || !sessionId) {
      alert('Please fill in both the Mosque Name and Session ID.');
      return;
    }

    try {
      btnSubmitCreate.disabled = true;
      btnSubmitCreate.textContent = 'Creating...';
      const res = await fetch('/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mosqueName, primaryLanguage })
      });
      if (res.ok) {
        const createdSession = await res.json();
        modalCreateSession.style.display = 'none';
        window.location.href = `/admin.html?session=${encodeURIComponent(createdSession.id || sessionId)}`;
      } else {
        const err = await res.json();
        alert('Error creating session: ' + (err.error || 'Failed'));
        btnSubmitCreate.disabled = false;
        btnSubmitCreate.textContent = 'Create & Launch Console →';
      }
    } catch (e) {
      alert('Error: ' + e.message);
      btnSubmitCreate.disabled = false;
      btnSubmitCreate.textContent = 'Create & Launch Console →';
    }
  });
}

// ─── STRICT CONTROL LOCKING LOGIC ───
function updateControlLockState() {
  const isLive = (sessionStatus === 'active');

  // Lock or Unlock Live Mic
  btnToggleMic.disabled = !isLive;

  // Lock or Unlock Manual Text Injection
  manualInput.disabled = !isLive;
  btnInject.disabled = !isLive;

  if (isLive) {
    manualInput.placeholder = 'Type speech text in any language (English, Arabic, Bengali, etc.)...';
    lockBanner.className = 'control-lock-banner unlocked';
    lockBannerIcon.textContent = '🟢';
    lockBannerText.innerHTML = '<strong>Session is LIVE!</strong> Microphone input and live translation broadcasting are enabled.';
  } else if (sessionStatus === 'paused') {
    manualInput.placeholder = 'Session paused. Click "▶ Resume" to continue...';
    lockBanner.className = 'control-lock-banner';
    lockBannerIcon.textContent = '⏸';
    lockBannerText.innerHTML = '<strong>Session is PAUSED.</strong> Translation is paused. Click <strong>"▶ Resume"</strong> to continue.';
    if (micActive) stopMicrophone();
  } else {
    manualInput.placeholder = 'Click "▶ Start" first to enable live speech input and testing...';
    lockBanner.className = 'control-lock-banner';
    lockBannerIcon.textContent = '🔒';
    lockBannerText.innerHTML = 'Controls are locked. Click <strong>"▶ Start"</strong> to activate the microphone and begin live translation broadcasting.';

    if (micActive) {
      stopMicrophone();
    }
  }
}

// ─── SESSION CONSOLE LIFECYCLE ───
function setSessionActive(startedAt) {
  sessionStatus = 'active';
  sessionBadge.className = 'badge badge-live';
  sessionStatusText.textContent = 'LIVE';
  btnStart.textContent = '▶ Start';
  btnStart.disabled = true;
  btnPause.textContent = '⏸ Pause';
  btnPause.disabled = false;
  btnEnd.textContent = '⏹ End';
  btnEnd.disabled = false;

  sessionStartTime = startedAt ? new Date(startedAt) : new Date();
  if (!timerInterval) {
    timerInterval = setInterval(updateTimerDisplay, 1000);
  }
  updateControlLockState();
}

function setSessionPaused() {
  sessionStatus = 'paused';
  sessionBadge.className = 'badge badge-idle';
  sessionStatusText.textContent = 'PAUSED';
  btnStart.textContent = '▶ Resume';
  btnStart.disabled = false;
  btnPause.disabled = true;
  btnEnd.disabled = false;
  updateControlLockState();
}

function setSessionEnded() {
  sessionStatus = 'ended';
  sessionBadge.className = 'badge badge-idle';
  sessionStatusText.textContent = 'ENDED';
  btnStart.textContent = '▶ Start';
  btnStart.disabled = false;
  btnPause.disabled = true;
  btnEnd.disabled = true;
  btnSimulate.textContent = '⚡ Simulate Demo';
  isSimulating = false;

  clearInterval(timerInterval);
  timerInterval = null;
  updateControlLockState();
}

function updateTimerDisplay() {
  if (!sessionStartTime) return;
  const elapsed = Math.floor((new Date() - sessionStartTime) / 1000);
  const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const secs = String(elapsed % 60).padStart(2, '0');
  liveTimer.textContent = `${hrs}:${mins}:${secs}`;
}

// Button Listeners
btnStart.addEventListener('click', async () => {
  setSessionActive(new Date().toISOString());
  try {
    await fetch(`/api/session/${currentSessionId}/start`, { method: 'POST' });
  } catch (e) { console.warn('Start error:', e.message); }
});

btnPause.addEventListener('click', async () => {
  setSessionPaused();
  try {
    await fetch(`/api/session/${currentSessionId}/pause`, { method: 'POST' });
  } catch (e) { console.warn('Pause error:', e.message); }
});

btnEnd.addEventListener('click', async () => {
  if (confirm('Are you sure you want to conclude this session?')) {
    setSessionEnded();
    try {
      await fetch(`/api/session/${currentSessionId}/end`, { method: 'POST' });
    } catch (e) { console.warn('End error:', e.message); }
  }
});

const btnClearScreen = document.getElementById('btn-clear-screen');
if (btnClearScreen) {
  btnClearScreen.addEventListener('click', async () => {
    if (!currentSessionId) return;
    const ok = confirm('Clear all current speech text on the TV display and attendee mobile screens for this session?');
    if (!ok) return;

    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CLEAR_SESSION_TEXT',
          sessionId: currentSessionId
        }));
      }

      await fetch(`/api/session/${currentSessionId}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.warn('Clear text error:', e.message);
    }
  });
}

btnSimulate.addEventListener('click', async () => {
  if (!isSimulating) {
    if (sessionStatus !== 'active') setSessionActive(new Date().toISOString());
    try {
      await fetch(`/api/session/${currentSessionId}/start`, { method: 'POST' });
      await fetch(`/api/session/${currentSessionId}/simulate/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs: 3800 })
      });
    } catch (e) {}
    isSimulating = true;
    btnSimulate.textContent = '⏹ Stop Simulation';
    btnSimulate.className = 'btn btn-danger';
  } else {
    try {
      await fetch(`/api/session/${currentSessionId}/simulate/stop`, { method: 'POST' });
    } catch (e) {}
    isSimulating = false;
    btnSimulate.textContent = '⚡ Simulate Demo';
    btnSimulate.className = 'btn btn-accent';
  }
});

// Manual Text Injection (Strictly guarded)
btnInject.addEventListener('click', async () => {
  if (sessionStatus !== 'active') {
    alert('Session is not active! Please click "▶ Start" or "▶ Resume" first.');
    return;
  }
  const text = manualInput.value.trim();
  if (!text) return;

  const chosenLang = speakerLangSelect ? speakerLangSelect.value : 'auto';
  try {
    const res = await fetch(`/api/session/${currentSessionId}/inject-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, inputLang: chosenLang })
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed injecting text');
      return;
    }
    manualInput.value = '';
  } catch (err) {
    console.warn('Inject error:', err.message);
  }
});

manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnInject.click();
});

// ─── HARDWARE MIC INPUT (Web Speech API) ───
btnToggleMic.addEventListener('click', async () => {
  if (sessionStatus !== 'active') {
    alert('Please click "▶ Start" before turning on the live microphone.');
    return;
  }

  if (!micActive) {
    startMicrophone();
  } else {
    stopMicrophone();
  }
});

async function startMicrophone() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    micInterval = setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, v) => a + v, 0) / dataArray.length;
      micLevelBar.style.width = `${Math.min(avg * 2.5, 100)}%`;
    }, 100);

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Live speech recognition requires Google Chrome or Safari.');
      return;
    }

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    speechRecognition = new SpeechRec();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = false;
    const activeSpeakerLang = speakerLangSelect ? speakerLangSelect.value : 'auto';
    speechRecognition.lang = getWebSpeechLang(activeSpeakerLang);
    speechRecognition.maxAlternatives = 1;

    let lastProcessedIndex = -1;
    let isRestarting = false;
    let lastSentText = '';
    let lastSentTime = 0;

    speechRecognition.onresult = async (evt) => {
      if (sessionStatus !== 'active') return;

      for (let i = evt.resultIndex; i < evt.results.length; ++i) {
        if (evt.results[i].isFinal) {
          const transcript = evt.results[i][0].transcript.trim();
          if (!transcript) continue;

          // Prevent duplicate firing within 1 second of exact same text
          const now = Date.now();
          if (transcript === lastSentText && now - lastSentTime < 1200) {
            continue;
          }

          lastSentText = transcript;
          lastSentTime = now;
          lastProcessedIndex = i;

          console.log('[Live Mic Recognized]:', transcript);
          const currentInputLang = speakerLangSelect ? speakerLangSelect.value : 'auto';
          try {
            await fetch(`/api/session/${currentSessionId}/inject-text`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: transcript, inputLang: currentInputLang })
            });
          } catch (err) {
            console.warn('[Live Mic] Inject error:', err.message);
          }
        }
      }
    };

    speechRecognition.onerror = (e) => {
      console.warn('[Live Mic] Speech recognition event:', e.error);
      if (e.error === 'no-speech') {
        // Natural pause between verses or sentences - keep mic alive!
        return;
      }
      if (e.error === 'not-allowed') {
        alert('Microphone permission was denied. Please allow microphone access.');
        stopMicrophone();
      }
    };

    speechRecognition.onend = () => {
      // CRITICAL: Reset index because a newly started SpeechRecognition instance resets results to index 0
      lastProcessedIndex = -1;

      // Auto-restart recognition seamlessly when mic is active so Imam pauses don't stop the session
      if (micActive && sessionStatus === 'active' && !isRestarting) {
        isRestarting = true;
        setTimeout(() => {
          isRestarting = false;
          if (micActive && sessionStatus === 'active') {
            try {
              speechRecognition.start();
            } catch (e) {}
          }
        }, 200);
      }
    };

    speechRecognition.start();
    micActive = true;
    btnToggleMic.textContent = '🛑 Stop Live Mic';
    btnToggleMic.className = 'btn btn-danger';
  } catch (err) {
    alert('Could not access microphone: ' + err.message);
  }
}

function stopMicrophone() {
  micActive = false;
  if (speechRecognition) {
    try { speechRecognition.stop(); } catch (e) {}
    speechRecognition = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  clearInterval(micInterval);
  micLevelBar.style.width = '0%';
  btnToggleMic.textContent = '🎤 Enable Live Mic';
  btnToggleMic.className = 'btn btn-secondary';
}

// ─── INITIALIZE CONSOLE SESSION ───
async function initConsoleSession(sessionId) {
  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (res.ok) {
      const data = await res.json();
      mosqueTitle.textContent = `${data.mosqueName} — Pulpit Console`;
      if (data.status === 'active') setSessionActive(data.startedAt);
      else if (data.status === 'paused') setSessionPaused();
      else if (data.status === 'ended') setSessionEnded();
      else updateControlLockState();

      if (data.stats) updateStatsDisplay(data.stats);
      if (data.tvFontSize) syncTvFontSizeUI(data.tvFontSize, data.tvCapacity);
      if (data.tvAudioEnabled !== undefined) syncTvAudioUI(data.tvAudioEnabled);
      if (data.tvShowQr !== undefined) syncTvQrUI(data.tvShowQr);
      if (data.speakerLanguage && speakerLangSelect) {
        speakerLangSelect.value = data.speakerLanguage;
      } else {
        try {
          const savedSpeaker = localStorage.getItem('mosq_speaker_lang');
          if (savedSpeaker && speakerLangSelect) speakerLangSelect.value = savedSpeaker;
        } catch (e) {}
      }

      // Update dynamic links with session primary language
      const joinUrl = `${window.location.origin}/join.html?session=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(data.primaryLanguage || 'en')}`;
      const tvUrl = `/display.html?session=${encodeURIComponent(sessionId)}`;
      if (btnOpenJoin) btnOpenJoin.href = joinUrl;
      if (btnOpenTvSide) btnOpenTvSide.href = tvUrl;
      if (headerBtnTv) headerBtnTv.href = tvUrl;

      if (qrCodeImg) {
        qrCodeImg.src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
      }

      if (btnCopyLink) {
        btnCopyLink.onclick = () => {
          navigator.clipboard.writeText(joinUrl).then(() => {
            btnCopyLink.textContent = '✅ Copied!';
            setTimeout(() => btnCopyLink.textContent = '📋 Copy Link', 2000);
          });
        };
      }
    }
  } catch (err) {}

  connectWebSocket(sessionId);
  startAdminStatsSync();
}

let adminStatsSyncInterval = null;
function startAdminStatsSync() {
  if (adminStatsSyncInterval) clearInterval(adminStatsSyncInterval);
  adminStatsSyncInterval = setInterval(async () => {
    if (!currentSessionId) return;
    try {
      const res = await fetch(`/api/session/${currentSessionId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.stats) updateStatsDisplay(data.stats);
      }
    } catch (e) {}
  }, 3000);
}

function updateStatsDisplay(stats) {
  if (!stats) return;
  const phones = stats.phoneAttendees !== undefined ? stats.phoneAttendees : (stats.totalAttendees || 0);
  const computers = stats.computerDisplays !== undefined ? stats.computerDisplays : (stats.tvDisplays || stats.totalTVDisplays || 0);
  const total = stats.totalBrowsers !== undefined ? stats.totalBrowsers : (phones + computers);

  if (statAttendees) statAttendees.textContent = phones;
  if (statDisplays) statDisplays.textContent = computers;

  const totalBadge = document.getElementById('stat-total-badge');
  if (totalBadge) {
    totalBadge.textContent = `${total} Active Browser${total === 1 ? '' : 's'}`;
  }

  if (languagesBreakdown) {
    languagesBreakdown.innerHTML = '';
    const counts = stats.languageCounts || {};
    const entries = Object.entries(counts);
    if (entries.length === 0) {
      languagesBreakdown.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">None active yet</span>';
    } else {
      entries.forEach(([lang, num]) => {
        const tag = document.createElement('span');
        tag.style.cssText = 'background: #334155; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600;';
        tag.textContent = `${lang.toUpperCase()}: ${num}`;
        languagesBreakdown.appendChild(tag);
      });
    }
  }
}

// ─── WEBSOCKET CONNECTION ───
function connectWebSocket(sessionId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'JOIN_ROOM',
      sessionId,
      role: 'admin'
    }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'SESSION_STATUS') {
        if (data.status === 'active') setSessionActive(data.startedAt);
        else if (data.status === 'paused') setSessionPaused();
        else if (data.status === 'ended') setSessionEnded();
      }
      if (data.type === 'SESSION_STATS' || data.type === 'STATS_UPDATE') {
        updateStatsDisplay(data.stats);
      }
      if (data.type === 'TV_SETTINGS_UPDATE') {
        syncTvFontSizeUI(data.tvFontSize, data.tvCapacity);
        if (data.tvAudioEnabled !== undefined) syncTvAudioUI(data.tvAudioEnabled);
        if (data.tvShowQr !== undefined) syncTvQrUI(data.tvShowQr);
      }
      if (data.type === 'LIVE_SUBTITLE') addTranscriptEntry(data);
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(() => connectWebSocket(sessionId), 3000);
  };
}

function addTranscriptEntry({ arabic, translations, ayah }) {
  if (!arabic) return;
  transcriptItemsCount++;
  if (transCount) transCount.textContent = `${transcriptItemsCount} lines`;

  const isRtl = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(arabic);
  const item = document.createElement('div');
  item.style.cssText = `padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-family: ${isRtl ? 'var(--font-arabic)' : 'inherit'}; font-size: 1.15rem; direction: ${isRtl ? 'rtl' : 'ltr'}; text-align: ${isRtl ? 'right' : 'left'}; color: #f8fafc;`;

  if (ayah) {
    const badge = document.createElement('span');
    badge.style.cssText = 'background: #f59e0b; color: #000; font-size: 0.68rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin-left: 0.5rem; font-family: sans-serif;';
    badge.textContent = `📖 ${ayah.reference || 'QURAN'}`;
    item.appendChild(badge);
  }

  const textSpan = document.createElement('span');
  item.appendChild(textSpan);

  if (transcriptFeed.children[0] && (transcriptFeed.children[0].textContent.includes('Spoken Arabic') || transcriptFeed.children[0].textContent.includes('Spoken Speech'))) {
    transcriptFeed.innerHTML = '';
  }
  transcriptFeed.prepend(item);

  const words = arabic.split(/\s+/).filter(Boolean);
  let wIdx = 0;
  const timer = setInterval(() => {
    if (wIdx < words.length) {
      textSpan.textContent += (wIdx === 0 ? '' : ' ') + words[wIdx];
      wIdx++;
    } else {
      clearInterval(timer);
    }
  }, 75);
}

// ─── CUSTOM KHUTBAH STREAMER (Preserved) ───
const customKhutbahText = document.getElementById('custom-khutbah-text');
const customKhutbahStatus = document.getElementById('custom-khutbah-status');
const btnDeliverKhutbah = document.getElementById('btn-deliver-khutbah');
const btnStopKhutbah = document.getElementById('btn-stop-khutbah');
const btnTplTaqwa = document.getElementById('btn-tpl-taqwa');
const btnTplEase = document.getElementById('btn-tpl-ease');
const btnTplCharacter = document.getElementById('btn-tpl-character');

const KHUTBAH_TEMPLATES = {
  taqwa: `الحمد لله نحمده ونستعينه ونستغفره، ونعوذ بالله من شرور أنفسنا.
يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون.
إن أصدق الحديث كتاب الله، وخير الهدي هدي محمد صلى الله عليه وسلم.`,
  ease: `الحمد لله رب العالمين، والصلاة والسلام على رسوله الكريم.
أيها المسلمون، إن مع العسر يسرا، وإن دوام الحال من المحال.
فإن مع العسر يسرا، إن مع العسر يسرا.`,
  character: `الحمد لله الذي ألف بين قلوبنا فأصبحنا بنعمته إخوانا.
المسلم أخو المسلم، لا يظلمه ولا يسلمه ولا يخذله.
إنما بعثت لأتمم مكارم الأخلاق.`
};

if (btnTplTaqwa) btnTplTaqwa.onclick = () => { customKhutbahText.value = KHUTBAH_TEMPLATES.taqwa; customKhutbahStatus.textContent = 'Template 1 Loaded'; };
if (btnTplEase) btnTplEase.onclick = () => { customKhutbahText.value = KHUTBAH_TEMPLATES.ease; customKhutbahStatus.textContent = 'Template 2 Loaded'; };
if (btnTplCharacter) btnTplCharacter.onclick = () => { customKhutbahText.value = KHUTBAH_TEMPLATES.character; customKhutbahStatus.textContent = 'Template 3 Loaded'; };

let deliveryQueue = [];
let deliveryIndex = 0;
let deliveryTimer = null;

if (btnDeliverKhutbah) {
  btnDeliverKhutbah.onclick = () => {
    const text = customKhutbahText.value.trim();
    if (!text) { alert('Please paste Arabic Khutbah text.'); return; }
    if (sessionStatus !== 'active') {
      setSessionActive(new Date().toISOString());
      fetch(`/api/session/${currentSessionId}/start`, { method: 'POST' }).catch(() => {});
    }

    deliveryQueue = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
    deliveryIndex = 0;
    btnDeliverKhutbah.style.display = 'none';
    btnStopKhutbah.style.display = 'inline-block';
    deliverNextSentence();
  };
}

if (btnStopKhutbah) {
  btnStopKhutbah.onclick = () => {
    clearTimeout(deliveryTimer);
    btnDeliverKhutbah.style.display = 'inline-block';
    btnStopKhutbah.style.display = 'none';
    customKhutbahStatus.textContent = 'Delivery stopped';
  };
}

async function deliverNextSentence() {
  if (deliveryIndex >= deliveryQueue.length) {
    btnDeliverKhutbah.style.display = 'inline-block';
    btnStopKhutbah.style.display = 'none';
    customKhutbahStatus.textContent = 'Khutbah delivered completely!';
    return;
  }

  const sentence = deliveryQueue[deliveryIndex];
  customKhutbahStatus.textContent = `Delivering sentence ${deliveryIndex + 1}/${deliveryQueue.length}...`;
  try {
    await fetch(`/api/session/${currentSessionId}/inject-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sentence })
    });
  } catch (e) {}

  deliveryIndex++;
  deliveryTimer = setTimeout(deliverNextSentence, 4500);
}

// ─── TV DISPLAY FONT SIZE & CAPACITY CONTROLS ───
const TV_PRESETS_INFO = {
  small: { scale: 80, capacity: 18, label: '18 Lines (High Capacity)', name: 'Compact' },
  medium: { scale: 100, capacity: 12, label: '12 Lines (3X Capacity)', name: 'Standard' },
  large: { scale: 125, capacity: 8, label: '8 Lines (Large Font)', name: 'Large' },
  xlarge: { scale: 150, capacity: 5, label: '5 Lines (Extra Large)', name: 'Extra Lg' }
};

let activeTvFontSize = 'medium';
let activeTvCapacity = 12;
let activeTvAudioEnabled = false; // Default: OFF (Admin controlled)
let activeTvShowQr = true; // Default: ON (Admin controlled)

function getTvCapacityBadge() { return document.getElementById('tv-capacity-badge'); }
function getTvScaleDisplay() { return document.getElementById('tv-scale-display'); }
function getTvFontSlider() { return document.getElementById('tv-font-slider'); }
function getTvAudioStatusBadge() { return document.getElementById('tv-audio-status-badge'); }
function getBtnToggleTvAudio() { return document.getElementById('btn-toggle-tv-audio'); }
function getTvAudioBtnIcon() { return document.getElementById('tv-audio-btn-icon'); }
function getTvAudioBtnText() { return document.getElementById('tv-audio-btn-text'); }
function getTvQrStatusBadge() { return document.getElementById('tv-qr-status-badge'); }
function getBtnToggleTvQr() { return document.getElementById('btn-toggle-tv-qr'); }
function getTvQrBtnIcon() { return document.getElementById('tv-qr-btn-icon'); }
function getTvQrBtnText() { return document.getElementById('tv-qr-btn-text'); }

function syncTvQrUI(showQr) {
  activeTvShowQr = showQr !== false;
  const badge = getTvQrStatusBadge();
  const btn = getBtnToggleTvQr();
  const icon = getTvQrBtnIcon();
  const text = getTvQrBtnText();

  if (activeTvShowQr) {
    if (badge) {
      badge.textContent = 'Visible (Shown)';
      badge.style.background = 'rgba(16, 185, 129, 0.2)';
      badge.style.color = '#34d399';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    }
    if (btn) {
      btn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
      btn.style.background = 'rgba(239, 68, 68, 0.15)';
      btn.style.color = '#fca5a5';
    }
    if (icon) icon.textContent = '👁️‍🗨️';
    if (text) text.textContent = 'Hide QR';
  } else {
    if (badge) {
      badge.textContent = 'Hidden (Removed)';
      badge.style.background = 'rgba(148, 163, 184, 0.15)';
      badge.style.color = '#94a3b8';
      badge.style.borderColor = 'rgba(148, 163, 184, 0.3)';
    }
    if (btn) {
      btn.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      btn.style.background = 'rgba(16, 185, 129, 0.15)';
      btn.style.color = '#34d399';
    }
    if (icon) icon.textContent = '📱';
    if (text) text.textContent = 'Show QR';
  }
}

async function toggleTvQr() {
  const nextState = !activeTvShowQr;
  activeTvShowQr = nextState;
  syncTvQrUI(nextState);

  if (!currentSessionId) return;

  // 1. Instant WebSocket broadcast to connected TV displays
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'UPDATE_TV_SETTINGS',
      sessionId: currentSessionId,
      fontSize: activeTvFontSize,
      capacity: activeTvCapacity,
      audioEnabled: activeTvAudioEnabled,
      showQr: nextState
    }));
  }

  // 2. Persist to server session storage
  try {
    await fetch(`/api/session/${currentSessionId}/tv-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fontSize: activeTvFontSize,
        capacity: activeTvCapacity,
        audioEnabled: activeTvAudioEnabled,
        showQr: nextState
      })
    });
  } catch (e) {}
}

function syncTvAudioUI(enabled) {
  activeTvAudioEnabled = Boolean(enabled);
  const badge = getTvAudioStatusBadge();
  const btn = getBtnToggleTvAudio();
  const icon = getTvAudioBtnIcon();
  const text = getTvAudioBtnText();

  if (activeTvAudioEnabled) {
    if (badge) {
      badge.textContent = '🔊 LIVE ON TV';
      badge.style.background = 'rgba(16, 185, 129, 0.2)';
      badge.style.color = '#34d399';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    }
    if (btn) {
      btn.style.borderColor = '#10b981';
      btn.style.background = 'rgba(16, 185, 129, 0.25)';
      btn.style.color = '#34d399';
    }
    if (icon) icon.textContent = '⏸';
    if (text) text.textContent = 'Turn OFF TV Audio';
  } else {
    if (badge) {
      badge.textContent = 'OFF (Muted)';
      badge.style.background = 'rgba(148, 163, 184, 0.15)';
      badge.style.color = '#94a3b8';
      badge.style.borderColor = 'rgba(148, 163, 184, 0.3)';
    }
    if (btn) {
      btn.style.borderColor = 'rgba(148, 163, 184, 0.3)';
      btn.style.background = 'rgba(30, 41, 59, 0.8)';
      btn.style.color = '#f8fafc';
    }
    if (icon) icon.textContent = '▶';
    if (text) text.textContent = 'Turn ON TV Audio';
  }
}

async function toggleTvAudio() {
  const nextState = !activeTvAudioEnabled;
  activeTvAudioEnabled = nextState;
  syncTvAudioUI(nextState);

  if (!currentSessionId) return;

  // 1. Instant WebSocket broadcast to connected TV displays
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'UPDATE_TV_SETTINGS',
      sessionId: currentSessionId,
      fontSize: activeTvFontSize,
      capacity: activeTvCapacity,
      audioEnabled: nextState,
      showQr: activeTvShowQr
    }));
  }

  // 2. Persist to server session storage
  try {
    await fetch(`/api/session/${currentSessionId}/tv-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fontSize: activeTvFontSize,
        capacity: activeTvCapacity,
        audioEnabled: nextState,
        showQr: activeTvShowQr
      })
    });
  } catch (e) {}
}

function syncTvFontSizeUI(fontSize, capacity) {
  if (!fontSize) return;
  activeTvFontSize = fontSize;
  if (capacity) activeTvCapacity = Number(capacity);

  const tvPresetBtns = document.querySelectorAll('.btn-tv-preset');
  tvPresetBtns.forEach(btn => {
    const isMatch = btn.getAttribute('data-size') === String(fontSize);
    if (isMatch) {
      btn.classList.add('active');
      btn.style.borderColor = '#10b981';
      btn.style.background = 'rgba(16, 185, 129, 0.2)';
      btn.style.color = '#34d399';
      btn.style.fontWeight = '700';
    } else {
      btn.classList.remove('active');
      btn.style.borderColor = 'rgba(148, 163, 184, 0.2)';
      btn.style.background = 'rgba(30, 41, 59, 0.7)';
      btn.style.color = '#f1f5f9';
      btn.style.fontWeight = 'normal';
    }
  });

  let scaleNum = 100;
  let capacityText = `${activeTvCapacity} Lines (3X Capacity)`;

  if (TV_PRESETS_INFO[fontSize]) {
    scaleNum = TV_PRESETS_INFO[fontSize].scale;
    activeTvCapacity = TV_PRESETS_INFO[fontSize].capacity;
    capacityText = TV_PRESETS_INFO[fontSize].label;
  } else if (!isNaN(Number(fontSize))) {
    scaleNum = Number(fontSize);
    activeTvCapacity = capacity || Math.max(4, Math.round(12 / (scaleNum / 100)));
    capacityText = `${activeTvCapacity} Lines (~${scaleNum}%)`;
  }

  const slider = getTvFontSlider();
  const scaleDisplay = getTvScaleDisplay();
  const capacityBadge = getTvCapacityBadge();

  if (slider) slider.value = scaleNum;
  if (scaleDisplay) scaleDisplay.textContent = `${scaleNum}%`;
  if (capacityBadge) capacityBadge.textContent = capacityText;
}

async function setTvFontSize(fontSize, capacity = null) {
  activeTvFontSize = fontSize;
  let targetCap = capacity;
  if (!targetCap && TV_PRESETS_INFO[fontSize]) {
    targetCap = TV_PRESETS_INFO[fontSize].capacity;
  }
  syncTvFontSizeUI(fontSize, targetCap);

  if (!currentSessionId) return;

  // 1. Instant WebSocket broadcast to connected TV displays
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'UPDATE_TV_SETTINGS',
      sessionId: currentSessionId,
      fontSize,
      capacity: targetCap,
      audioEnabled: activeTvAudioEnabled,
      showQr: activeTvShowQr
    }));
  }

  // 2. Persist to server session storage
  try {
    await fetch(`/api/session/${currentSessionId}/tv-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fontSize,
        capacity: targetCap,
        audioEnabled: activeTvAudioEnabled,
        showQr: activeTvShowQr
      })
    });
  } catch (e) {}
}

function initTvFontControls() {
  const tvPresetBtns = document.querySelectorAll('.btn-tv-preset');
  tvPresetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.getAttribute('data-size');
      setTvFontSize(size);
    });
  });

  const slider = getTvFontSlider();
  if (slider) {
    slider.addEventListener('input', (e) => {
      const scale = Number(e.target.value);
      const capacity = Math.max(4, Math.round(12 / (scale / 100)));
      syncTvFontSizeUI(scale, capacity);
    });

    slider.addEventListener('change', (e) => {
      const scale = Number(e.target.value);
      const capacity = Math.max(4, Math.round(12 / (scale / 100)));
      setTvFontSize(scale, capacity);
    });
  }

  const btnToggleTvAudio = getBtnToggleTvAudio();
  if (btnToggleTvAudio) {
    btnToggleTvAudio.addEventListener('click', toggleTvAudio);
  }

  const btnToggleTvQr = getBtnToggleTvQr();
  if (btnToggleTvQr) {
    btnToggleTvQr.addEventListener('click', toggleTvQr);
  }
}

// ─── INITIALIZATION ───
async function init() {
  initTvFontControls();
  const authed = await checkAuth();
  if (authed) {
    setupViewRouting();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
