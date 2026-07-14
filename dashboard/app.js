// ── State ──
let state = { bot: null, connection: null, vad: null, profiles: null, presets: null, logs: [] };
let voiceMode = 'profile'; // 'profile' or 'preset'
let selectedPresetId = null;
let selectedEffect = 'none'; // V2.2: audio effect
let v2vEnabled = false;      // V2.3: voice-to-voice toggle
let v2vTargetUser = '';      // V2.3: target user for V2V
let apiKey = '';
let wsConnection = null;     // V2.4: WebSocket for waveform

// V2.4: WebSocket waveform connection
function initWaveformSocket() {
  // Determine WebSocket URL from current page host
  const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  const wsUrl = proto + window.location.host;
  
  try {
    wsConnection = new WebSocket(wsUrl);
    
    wsConnection.onopen = () => {
      console.log('📡 Waveform WebSocket connected');
    };
    
    wsConnection.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'amplitude') {
          // Update waveform with real amplitude data
          lastAmplitude = data.value;
        }
      } catch { /* ignore parse errors */ }
    };
    
    wsConnection.onclose = () => {
      console.log('📡 Waveform WebSocket disconnected — reconnecting in 5s');
      setTimeout(initWaveformSocket, 5000);
    };
    
    wsConnection.onerror = () => {
      wsConnection.close();
    };
  } catch {
    // WebSocket not available — waveform continues with animation only
    console.log('📡 Waveform WebSocket unavailable — using animated fallback');
  }
}

// Security: prompt for API key instead of reading from URL (avoids leakage in
// browser history, referrer headers, and server access logs).
function initApiKey() {
  const stored = sessionStorage.getItem('shadowvox_apikey');
  if (stored) {
    apiKey = stored;
    return;
  }
  // Check if the server actually requires a key by making an unauthenticated request
  fetch('/api/status', { headers: { 'Content-Type': 'application/json' } })
    .then(res => {
      if (res.status === 401) {
        const key = prompt('Enter Admin API Key:');
        if (key) {
          apiKey = key;
          sessionStorage.setItem('shadowvox_apikey', key);
        }
      }
    })
    .catch(() => {});
}

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

// ── Toast ──
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── V2.4: Live Waveform ──
const canvas = document.getElementById('waveformCanvas');
const ctx = canvas.getContext('2d');
let waveformPhase = 0;
let lastAmplitude = 0;
let targetAmplitude = 0;

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function drawWaveform(active) {
  const w = canvas.width / devicePixelRatio;
  const h = canvas.height / devicePixelRatio;
  if (!w || !h) { requestAnimationFrame(() => drawWaveform(active)); return; }
  ctx.clearRect(0, 0, w, h);

  // Smooth amplitude interpolation
  targetAmplitude = active ? Math.min(1, lastAmplitude * 2 + 0.3) : 0.05;
  const amp = h * 0.35 * Math.max(0.05, targetAmplitude);

  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, active ? 'rgba(139,92,246,0.45)' : 'rgba(84,90,106,0.15)');
  gradient.addColorStop(0.5, active ? 'rgba(34,211,238,0.45)' : 'rgba(84,90,106,0.15)');
  gradient.addColorStop(1, active ? 'rgba(139,92,246,0.45)' : 'rgba(84,90,106,0.15)');

  ctx.strokeStyle = gradient;
  ctx.lineWidth = active ? 2.5 : 1.5;
  ctx.beginPath();

  const bars = Math.floor(w / 4);
  const phaseSpeed = active ? 0.035 : 0.06;

  for (let i = 0; i <= bars; i++) {
    const x = (i / bars) * w;
    // V2.4: Modulate waveform by real amplitude data + multiple sine waves for richness
    const mod = active
      ? Math.sin(x * 0.045 + waveformPhase) * (0.6 + 0.4 * Math.sin(x * 0.008)) +
        Math.sin(x * 0.09 + waveformPhase * 1.4) * 0.2 +
        Math.sin(x * 0.02 + waveformPhase * 0.6) * 0.15
      : Math.sin(x * phaseSpeed + waveformPhase) * 0.3;
    const y = h/2 + mod * amp;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // V2.4: Add glow effect when active
  if (active && amp > h * 0.1) {
    ctx.shadowColor = 'rgba(139,92,246,0.3)';
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  waveformPhase += phaseSpeed;
  requestAnimationFrame(() => drawWaveform(active));
}
drawWaveform(false);

// ── Fetch Status ──
async function fetchStatus() {
  try {
    const res = await fetch('/api/status', { headers: apiHeaders() });
    if (!res.ok) throw new Error('API error: ' + res.status);
    state = await res.json();
    renderAll();
  } catch (err) {
    document.getElementById('statusBadge').className = 'status-badge offline';
    document.getElementById('statusText').textContent = 'Offline';
  }
}

// ── Render ──
function renderAll() {
  // Header badges
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  if (state.bot?.online) {
    badge.className = 'status-badge online';
    text.textContent = state.bot.username + ' • Online';
  } else {
    badge.className = 'status-badge offline';
    text.textContent = 'Offline';
  }

  // Connection status
  const conn = state.connection;
  const connected = conn?.connected;
  const connEl = document.getElementById('connStatus');
  connEl.innerHTML = connected
    ? '<span class="pulse-dot online"></span> Connected'
    : '<span class="pulse-dot idle"></span> Disconnected';
  document.getElementById('connGuild').textContent = conn?.guildName || '—';
  document.getElementById('connChannel').textContent = conn?.channelName || '—';
  document.getElementById('connBot').textContent = state.bot?.username || '—';
  document.getElementById('connGuilds').textContent = state.bot?.guilds ?? '0';

  // Waveform
  const waveformText = document.getElementById('waveformText');
  if (connected) {
    waveformText.textContent = '● Live • ' + (conn.channelName || 'Voice') + ' in ' + (conn.guildName || 'Server');
    drawWaveform(true);
  } else {
    waveformText.textContent = '○ Standing by — not connected to any voice channel';
    drawWaveform(false);
  }

  // Connection card glow
  document.getElementById('connectionCard').style.borderColor = connected
    ? 'rgba(74,222,128,0.3)'
    : 'var(--border)';

  // Profiles
  renderProfiles();
  renderSpeakDropdown();
  renderPresetDropdown();
  renderActivePresetBadge();
  renderLogs();
}

// ── Profiles ──
function renderProfiles() {
  const list = document.getElementById('profileList');
  const count = document.getElementById('profileCount');
  const profiles = state.profiles?.list || [];

  count.textContent = profiles.length;

  if (!profiles.length) {
    list.innerHTML = '<div class="empty-state">No profiles yet. Record a voice first!</div>';
    return;
  }

  list.innerHTML = profiles.map(p => {
    const initial = (p.username || p.userId || '?')[0].toUpperCase();
    const time = new Date(p.recordedAt).toLocaleDateString();
    const duration = p.sampleDurationMs ? (p.sampleDurationMs / 1000).toFixed(1) + 's' : '—';
    const shortId = p.userId.slice(-6);
    return '<div class="profile-item">' +
      '<div class="profile-avatar">' + initial + '</div>' +
      '<div class="profile-info">' +
        '<div class="profile-name">' + escapeHtml(p.username || p.userId) + '</div>' +
        '<div class="profile-meta">' +
          '<span>🗓️ ' + time + '</span>' +
          '<span>⏱️ ' + duration + '</span>' +
          '<span>🆔 …' + shortId + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="profile-actions">' +
        '<button class="btn btn-secondary btn-sm" onclick="playReference(\'' + p.userId + '\')" title="Play Reference">🔊 Ref</button>' +
        '<button class="btn btn-danger btn-sm" onclick="deleteProfile(\'' + p.userId + '\')" title="Delete">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderSpeakDropdown() {
  const sel = document.getElementById('speakUser');
  const btn = document.getElementById('speakBtn');
  const profiles = state.profiles?.list || [];

  if (voiceMode === 'profile') {
    sel.style.display = '';
    if (profiles.length) {
      const currentValue = sel.value;
      sel.innerHTML = '<option value="">Select a voice profile...</option>' +
        profiles.map(p => '<option value="' + p.userId + '"' + (p.userId === currentValue ? ' selected' : '') + '>' +
          escapeHtml(p.username || p.userId) + '</option>').join('');
      btn.disabled = false;
    } else {
      sel.innerHTML = '<option value="">— No profiles —</option>';
      btn.disabled = true;
    }
  }
}

// ── Presets ──
function renderPresetDropdown() {
  const catSel = document.getElementById('presetCategory');
  if (!catSel) return;
  
  const presets = state.presets?.list || [];
  const categories = [...new Set(presets.map(p => p.category))];
  
  const currentValue = catSel.value;
  catSel.innerHTML = '<option value="">— All Categories —</option>' +
    categories.map(c => '<option value="' + c + '"' + (c === currentValue ? ' selected' : '') + '>' +
      escapeHtml(c.charAt(0).toUpperCase() + c.slice(1).replace('-', ' ')) + '</option>').join('');
}

function renderPresetGrid() {
  const grid = document.getElementById('presetGrid');
  if (!grid) return;
  
  const presets = state.presets?.list || [];
  if (!presets.length) { grid.innerHTML = ''; return; }
  
  const category = document.getElementById('presetCategory')?.value || '';
  const filtered = category ? presets.filter(p => p.category === category) : presets;
  
  grid.innerHTML = filtered.map(p => {
    const isActive = selectedPresetId === p.id;
    const availClass = p.available ? '' : 'unavailable';
    const activeClass = isActive ? 'active' : '';
    
    let html = '<div class="preset-chip ' + availClass + ' ' + activeClass + '" ' +
      (p.available ? 'onclick="selectPreset(\'' + escapeHtml(p.id) + '\')"' : 'title="Place presets/' + escapeHtml(p.id) + '.wav to activate"') + '>' +
      '<span class="chip-emoji">' + escapeHtml(p.emoji) + '</span>' +
      '<span class="chip-name">' + escapeHtml(p.name) + '</span>';
    
    // Add play sample button (only for available presets)
    if (p.available) {
      html += '<button class="chip-play" onclick="event.stopPropagation();playPresetSample(\'' + p.id + '\')" title="Play sample of ' + escapeHtml(p.name) + '">▶</button>';
    }
    
    html += '</div>';
    return html;
  }).join('');
}

// ── Play Preset Sample ──
async function playPresetSample(presetId) {
  const btn = document.querySelector('.preset-chip.active .chip-play') || event?.target;
  const originalText = btn?.textContent || '▶';
  if (btn) btn.textContent = '⏳';
  
  try {
    const res = await fetch('/api/play-preset/' + presetId, { method:'POST', headers: apiHeaders() });
    const data = await res.json();
    if (data.status === 'success') {
      const preset = (state.presets?.list || []).find(p => p.id === presetId);
      showToast('🔊 ' + (preset?.emoji || '') + ' Playing ' + (data.preset || presetId));
    } else {
      showToast('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    showToast('❌ Network error', 'error');
  }
  
  if (btn) btn.textContent = originalText;
}

function renderActivePresetBadge() {
  const badge = document.getElementById('presetBadge');
  if (!badge) return;
  const active = state.activePreset;
  if (active) {
    badge.innerHTML = active.emoji + ' ' + escapeHtml(active.name);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ── Voice Mode Switching ──
function switchVoiceMode(mode) {
  voiceMode = mode;
  const tabs = document.querySelectorAll('.voice-tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  
  document.getElementById('speakUserGroup').style.display = mode === 'profile' ? '' : 'none';
  document.getElementById('presetGroup').style.display = mode === 'preset' ? '' : 'none';
  document.getElementById('presetGrid').style.display = mode === 'preset' ? '' : 'none';
  
  if (mode === 'preset') {
    renderPresetGrid();
  }
  
  const btn = document.getElementById('speakBtn');
  btn.disabled = (mode === 'profile' && (!state.profiles?.list?.length));
}

function selectPreset(presetId) {
  selectedPresetId = selectedPresetId === presetId ? null : presetId;
  document.getElementById('speakBtn').disabled = !selectedPresetId;
  renderPresetGrid();
  
  const preset = (state.presets?.list || []).find(p => p.id === presetId);
  if (preset) {
    showToast('🎭 Selected ' + preset.emoji + ' ' + preset.name);
  }
}

// ── Logs ──
function renderLogs() {
  const container = document.getElementById('logContainer');
  const count = document.getElementById('logCount');
  const logs = state.logs || [];

  count.textContent = logs.length;

  if (!logs.length) {
    container.innerHTML = '<div class="empty-state">Waiting for activity...</div>';
    return;
  }

  container.innerHTML = logs.slice().reverse().map(log => {
    const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
    const time = new Date(log.timestamp).toLocaleTimeString();
    return '<div class="log-entry">' +
      '<span class="log-time">' + time + '</span>' +
      '<span class="log-icon">' + (icons[log.level] || '•') + '</span>' +
      '<span class="log-msg">' + escapeHtml(log.message) + '</span>' +
    '</div>';
  }).join('');

  container.scrollTop = 0;
}

// ── Helpers ──
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Play Reference Audio ──
async function playReference(userId) {
  try {
    const res = await fetch('/api/play-reference/' + userId, { method:'POST', headers: apiHeaders() });
    const data = await res.json();
    if (data.status === 'success') showToast('🔊 Playing reference audio');
    else showToast('❌ ' + (data.error || 'Failed'), 'error');
  } catch { showToast('❌ Network error', 'error'); }
}

// ── Delete Profile ──
async function deleteProfile(userId) {
  if (!confirm('Delete this voice profile?')) return;
  try {
    const res = await fetch('/api/profiles/' + userId, { method:'DELETE', headers: apiHeaders() });
    if (res.ok) { showToast('🗑️ Profile deleted'); fetchStatus(); }
    else showToast('❌ Failed to delete', 'error');
  } catch { showToast('❌ Network error', 'error'); }
}

// ── Join / Leave VC ──
async function joinVC() {
  const guildId = prompt('Enter Guild (Server) ID:');
  if (!guildId) return;
  const channelId = prompt('Enter Voice Channel ID:');
  if (!channelId) return;
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const res = await fetch('/api/join', { method:'POST', headers: apiHeaders(),
      body: JSON.stringify({ guildId, channelId }) });
    const data = await res.json();
    if (data.status === 'success') showToast('🔊 Joined ' + data.channel);
    else showToast('❌ ' + (data.error || 'Failed'), 'error');
  } catch { showToast('❌ Network error', 'error'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '🔊 Join VC'; }
  fetchStatus();
}

async function leaveVC() {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const res = await fetch('/api/leave', { method:'POST', headers: apiHeaders() });
    const data = await res.json();
    if (data.status === 'success') showToast('👋 Left ' + (data.left || 'channel'));
    else showToast('❌ ' + (data.error || 'Failed'), 'error');
  } catch { showToast('❌ Network error', 'error'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '⏹ Leave'; }
  fetchStatus();
}

// ── Speak ──
document.getElementById('speakBtn').addEventListener('click', async () => {
  const text = document.getElementById('speakText').value.trim();
  const lang = document.getElementById('speakLang').value;

  if (!text) {
    showToast('Enter text to speak', 'error');
    return;
  }

  const btn = document.getElementById('speakBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Cloning...';

  const body = { text, language: lang };

  if (voiceMode === 'preset' && selectedPresetId) {
    body.presetId = selectedPresetId;
  } else {
    const userId = document.getElementById('speakUser').value;
    if (!userId) {
      showToast('Select a profile or preset first', 'error');
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">📡</span> Transmit to VC';
      return;
    }
    body.userId = userId;
  }

  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.status === 'success') {
      const label = data.preset || 'Voice cloned';
      showToast('🔊 ' + label + ' transmitted!');
      document.getElementById('speakText').value = '';
    } else {
      showToast('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    showToast('❌ Network error', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<span class="btn-icon">📡</span> Transmit to VC';
  fetchStatus();
});

// ── VAD Controls ──
function updateVad() {
  const config = {
    enabled: document.getElementById('vadEnabled').checked,
    autoClone: document.getElementById('vadClone').checked,
    listenToAll: document.getElementById('vadAll').checked,
    silenceDurationMs: parseInt(document.getElementById('silenceRange').value),
    cooldownMs: parseInt(document.getElementById('cooldownRange').value) * 1000,
  };
  fetch('/api/vad', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(config),
  }).catch(() => {});
}

function updateSilenceLabel() {
  const val = parseInt(document.getElementById('silenceRange').value);
  document.getElementById('silenceValue').textContent = (val / 1000).toFixed(1) + 's';
}

function updateCooldownLabel() {
  const val = parseInt(document.getElementById('cooldownRange').value);
  document.getElementById('cooldownValue').textContent = val + 's';
}

// ── Record Modal ──
function openRecordModal() {
  document.getElementById('recordModal').classList.add('open');
}
function closeRecordModal() {
  document.getElementById('recordModal').classList.remove('open');
}

async function triggerRecording() {
  const userId = document.getElementById('recordUserId').value.trim();
  const username = document.getElementById('recordUsername').value.trim();
  if (!userId) { showToast('User ID is required', 'error'); return; }

  const btn = document.querySelector('#recordModal .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Recording...';

  try {
    const res = await fetch('/api/record', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ userId, username: username || undefined }),
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast('✅ Voice profile saved!');
      closeRecordModal();
      document.getElementById('recordUserId').value = '';
      document.getElementById('recordUsername').value = '';
    } else {
      showToast('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    showToast('❌ Network error', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '🎙️ Start Recording';
  fetchStatus();
}

// ── Regenerate README ──
async function regenerateReadme() {
  const btn = document.getElementById('readmeBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';

  try {
    const res = await fetch('/api/regenerate-readme', { method: 'POST', headers: apiHeaders() });
    const data = await res.json();
    if (data.status === 'success') {
      showToast('📝 README.md generated (' + data.size + ')');
    } else {
      showToast('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    showToast('❌ Network error', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '📝 Sync & Regenerate README.md';
}

// ── TTS Health ──
async function checkTTSHealth() {
  const btn = document.getElementById('healthBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Checking...';

  try {
    const res = await fetch('/api/health', { headers: apiHeaders() });
    const data = await res.json();
    const badge = document.getElementById('ttsBadge');
    const dot = document.querySelector('.tts-dot');
    const txt = document.getElementById('ttsText');
    if (data.online) {
      badge.className = 'tts-badge online';
      dot.style.background = 'var(--accent-purple)';
      txt.textContent = 'TTS Online';
      showToast('✅ TTS server is running');
    } else {
      badge.className = 'tts-badge offline';
      dot.style.background = 'var(--text-muted)';
      txt.textContent = 'TTS Offline';
      showToast('❌ TTS server unreachable', 'error');
    }
  } catch {
    showToast('❌ Network error', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '🩺 Check TTS Health';
}

// ── Refresh Profiles ──
function refreshProfiles() {
  fetchStatus();
}

// ── Init ──
initApiKey();
fetchStatus();
setInterval(fetchStatus, 3000);
