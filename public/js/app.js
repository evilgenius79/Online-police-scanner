'use strict';

// ═══════════════════════════════════════════════════════════ STATE
const S = {
  playing:      false,
  muted:        false,
  recording:    false,
  volume:       0.8,
  connected:    false,
  live:         false,
  sigLevel:     0,
  activeTx:     false,
  listeners:    0,
  txCount:      0,
  channels:     [],
  audioCtx:     null,
  analyser:     null,
  mediaRec:     null,
  recChunks:    [],
  recTimeout:   null,
  sessionStart: null,
  uptimeTimer:  null,
  rafId:        null,
  idleRafId:    null,
};

// ═══════════════════════════════════════════════════════════ STATE (extra)
// S already declared above; extend it here
Object.assign(S, {
  serialEnabled:   false,
  serialConnected: false,
  lastScannerData: null,
});

// ═══════════════════════════════════════════════════════════ DOM REFS
const $ = id => document.getElementById(id);
const D = {
  connectScreen: $('connect-screen'),
  connectBtn:    $('connect-btn'),
  connectSub:    $('connect-sub'),
  app:           $('app'),
  hdrName:       $('hdr-name'),
  hdrLoc:        $('hdr-loc'),
  statusDot:     $('status-dot'),
  statusLbl:     $('status-lbl'),
  txFlash:       $('tx-flash'),
  statListeners: $('stat-listeners'),
  statTx:        $('stat-tx'),
  clock:         $('clock'),
  helpBtn:       $('help-btn'),
  viz:           $('viz'),
  wave:          $('wave'),
  audio:         $('audio'),
  btnPlay:       $('btn-play'),
  btnMute:       $('btn-mute'),
  volume:        $('volume'),
  freqVal:       $('freq-val'),
  btnRec:        $('btn-rec'),
  btnClips:      $('btn-clips'),
  btnShare:      $('btn-share'),
  btnFs:         $('btn-fs'),
  chCount:       $('ch-count'),
  channelList:   $('channel-list'),
  signalPct:     $('signal-pct'),
  vuBars:        $('vu-bars'),
  sysUptime:     $('sys-uptime'),
  sysHost:       $('sys-host'),
  sysDevice:     $('sys-device'),
  sysBitrate:    $('sys-bitrate'),
  sysLoad:       $('sys-load'),
  // Scanner info bar
  sibSys:        $('sib-sys'),
  sibGrp:        $('sib-grp'),
  sibChn:        $('sib-chn'),
  sibMod:        $('sib-mod'),
  sibNac:        $('sib-nac'),
  sibSerial:     $('sib-serial'),
  sibBar:        $('sib'),
  // TX flash extras
  txChanInfo:    $('tx-chan-info'),
  txSep:         $('tx-sep'),
  activityLog:   $('activity-log'),
  btnClearLog:   $('btn-clear-log'),
  modalClips:    $('modal-clips'),
  clipsBody:     $('clips-body'),
  closeClips:    $('close-clips'),
  modalHelp:     $('modal-help'),
  closeHelp:     $('close-help'),
  playPath:      document.getElementById('play-path'),
  mutePath:      document.getElementById('mute-path'),
  fsPath:        document.getElementById('fs-path'),
  toaster:       $('toaster'),
};

// Canvas contexts
const VC = D.viz.getContext('2d');
const WC = D.wave.getContext('2d');

// ═══════════════════════════════════════════════════════════ INIT
document.addEventListener('DOMContentLoaded', () => {
  buildVuBars(24);
  bindEvents();
  setInterval(updateClock, 1000);
  updateClock();

  const ro = new ResizeObserver(resizeCanvases);
  ro.observe(D.viz.parentElement);
  ro.observe(D.wave.parentElement);
  resizeCanvases();

  // Idle animation until user connects
  idleLoop();
});

function bindEvents() {
  D.connectBtn.addEventListener('click', onConnect);
  D.btnPlay.addEventListener('click', togglePlay);
  D.btnMute.addEventListener('click', toggleMute);
  D.volume.addEventListener('input', onVolume);
  D.btnRec.addEventListener('click', toggleRecord);
  D.btnClips.addEventListener('click', openClipsModal);
  D.btnShare.addEventListener('click', shareLink);
  D.btnFs.addEventListener('click', toggleFs);
  D.helpBtn.addEventListener('click', () => openModal(D.modalHelp));
  D.btnClearLog.addEventListener('click', clearLog);

  D.closeClips.addEventListener('click', () => closeModal(D.modalClips));
  D.closeHelp.addEventListener('click',  () => closeModal(D.modalHelp));
  D.modalClips.addEventListener('click', e => { if (e.target === D.modalClips) closeModal(D.modalClips); });
  D.modalHelp.addEventListener('click',  e => { if (e.target === D.modalHelp) closeModal(D.modalHelp); });

  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFsChange);
}

// ═══════════════════════════════════════════════════════ CONNECT
function onConnect() {
  // Web Audio API requires user gesture to start
  if (!S.audioCtx) {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.analyser  = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 2048;
    S.analyser.smoothingTimeConstant = 0.82;

    try {
      const src = S.audioCtx.createMediaElementSource(D.audio);
      src.connect(S.analyser);
      S.analyser.connect(S.audioCtx.destination);
    } catch (e) {
      console.warn('AudioContext wiring failed (already wired?):', e.message);
    }
  }

  initSocket();
  startAudio();

  D.connectScreen.classList.add('hidden');
  D.app.classList.remove('hidden');

  S.sessionStart = Date.now();
  S.uptimeTimer  = setInterval(updateUptime, 1000);

  // Switch from idle to live animation loop
  if (S.idleRafId) { cancelAnimationFrame(S.idleRafId); S.idleRafId = null; }
  S.rafId = requestAnimationFrame(vizLoop);
}

// ═══════════════════════════════════════════════════════ SOCKET.IO
let socket;
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect',    () => { S.connected = true;  updateStatus('online'); });
  socket.on('disconnect', () => { S.connected = false; S.live = false; updateStatus('offline'); });

  socket.on('init', data => {
    S.live      = data.live;
    S.listeners = data.listeners;
    S.txCount   = data.transmissionCount;

    updateStatus(data.live ? 'live' : 'online');
    D.statListeners.textContent = data.listeners;
    D.statTx.textContent        = data.transmissionCount;

    if (data.scanner) {
      D.hdrName.textContent    = data.scanner.name;
      D.hdrLoc.textContent     = data.scanner.location;
      D.connectSub.textContent = data.scanner.name;
      if (data.scanner.channels?.length) renderChannels(data.scanner.channels);
    }

    if (data.log?.length) {
      clearLog();
      [...data.log].reverse().forEach(addLog);
    }

    // Serial / scanner state
    if (data.serial) {
      S.serialEnabled   = data.serial.enabled;
      S.serialConnected = data.serial.connected;
      updateSerialDot();
      D.sysDevice.textContent = data.serial.enabled
        ? (data.serial.connected ? '✓ serial connected' : '✗ serial offline')
        : 'no serial configured';
      if (data.serial.data) {
        S.lastScannerData = data.serial.data;
        updateScannerInfoBar(data.serial.data);
        updateFreqFromScanner(data.serial.data);
        matchChannelInList(data.serial.data);
      }
    }

    // System info from first init call to /api/status
    fetchStatus();
  });

  socket.on('status', d => {
    S.live = d.live;
    updateStatus(d.live ? 'live' : 'online');
    if (!d.live) setTxFlash(false);
  });

  socket.on('signal', d => {
    S.sigLevel = d.level ?? 0;
    S.activeTx = d.active ?? false;
    updateVuBars(S.sigLevel);
    setTxFlash(S.activeTx);
    D.signalPct.textContent = S.sigLevel + '%';
  });

  socket.on('listeners', d => {
    S.listeners = d.count;
    D.statListeners.textContent = d.count;
  });

  socket.on('activity', entry => {
    if (entry.count !== undefined) {
      S.txCount = entry.count;
      D.statTx.textContent = entry.count;
    }
    addLog(entry);
  });

  // ── Scanner serial events ──
  socket.on('scanner', data => {
    S.lastScannerData = data;
    updateScannerInfoBar(data);
    updateFreqFromScanner(data);
    matchChannelInList(data);
  });

  socket.on('scannerStatus', d => {
    S.serialConnected = d.connected;
    updateSerialDot();
    D.sysDevice.textContent = d.connected ? '✓ serial connected' : '✗ serial offline';
  });
}

async function fetchStatus() {
  try {
    const res  = await fetch('/api/status');
    const data = await res.json();
    D.sysHost.textContent    = data.system?.hostname ?? '—';
    D.sysLoad.textContent    = data.system?.loadavg ? data.system.loadavg[0].toFixed(2) : '—';
    D.sysDevice.textContent  = data.scanner?.name ? '✓ connected' : '—';
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════ AUDIO
function startAudio() {
  D.audio.src = `/stream?t=${Date.now()}`;
  D.audio.volume = S.volume;
  D.audio.muted  = S.muted;

  D.audio.play().catch(() => {
    // Autoplay blocked — wait for manual play
    S.playing = false;
    updatePlayBtn();
  });

  D.audio.addEventListener('playing', () => { S.playing = true;  updatePlayBtn(); });
  D.audio.addEventListener('pause',   () => { S.playing = false; updatePlayBtn(); });
  D.audio.addEventListener('error',   onAudioError);
  D.audio.addEventListener('waiting', () => { /* buffering – could show spinner */ });

  S.playing = true;
  updatePlayBtn();
}

function onAudioError() {
  S.playing = false;
  updatePlayBtn();
  setTimeout(() => {
    if (!S.playing) {
      D.audio.src = `/stream?t=${Date.now()}`;
      D.audio.play().catch(() => {});
    }
  }, 4000);
}

function togglePlay() {
  if (S.playing) {
    D.audio.pause();
  } else {
    D.audio.src = `/stream?t=${Date.now()}`;
    D.audio.play().catch(() => {});
  }
}

function toggleMute() {
  S.muted       = !S.muted;
  D.audio.muted = S.muted;
  updateMuteBtn();
}

function onVolume(e) {
  S.volume       = e.target.value / 100;
  D.audio.volume = S.volume;
  D.volume.style.setProperty('--vol', e.target.value + '%');
  if (S.muted) toggleMute();
}

function updatePlayBtn() {
  if (S.playing) {
    D.playPath.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    D.btnPlay.classList.add('playing');
  } else {
    D.playPath.setAttribute('d', 'M8 5v14l11-7z');
    D.btnPlay.classList.remove('playing');
  }
}

function updateMuteBtn() {
  if (S.muted) {
    D.mutePath.setAttribute('d', 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z');
    D.btnMute.classList.add('recording'); // red glow for muted
  } else {
    D.mutePath.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z');
    D.btnMute.classList.remove('recording');
  }
}

// ═══════════════════════════════════════════════════════ RECORDING
function toggleRecord() {
  if (S.recording) stopRecord();
  else startRecord();
}

function startRecord() {
  if (!S.analyser) { toast('Connect audio first', 'error'); return; }

  const dest = S.audioCtx.createMediaStreamDestination();
  // Tap the analyser output into the recorder stream
  S.analyser.connect(dest);

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  S.recChunks = [];
  S.mediaRec  = new MediaRecorder(dest.stream, { mimeType: mime });

  S.mediaRec.ondataavailable = e => { if (e.data.size > 0) S.recChunks.push(e.data); };
  S.mediaRec.onstop          = saveRecord;
  S.mediaRec.start(100);

  S.recording = true;
  D.btnRec.classList.add('recording');
  addLog({ type: 'info', time: new Date().toISOString(), message: '⏺ Recording started' });
  toast('⏺ Recording…');

  // Auto-stop after 10 min
  S.recTimeout = setTimeout(stopRecord, 10 * 60 * 1000);
}

function stopRecord() {
  if (!S.recording) return;
  clearTimeout(S.recTimeout);
  S.mediaRec?.stop();
  S.recording = false;
  D.btnRec.classList.remove('recording');
}

function saveRecord() {
  const blob = new Blob(S.recChunks, { type: S.mediaRec?.mimeType ?? 'audio/webm' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `scanner-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
  });
  a.click();
  URL.revokeObjectURL(url);
  addLog({ type: 'info', time: new Date().toISOString(), message: '✅ Clip saved to downloads' });
  toast('✅ Clip saved to downloads', 'success');
}

// ═══════════════════════════════════════════════════════ CLIPS MODAL
async function openClipsModal() {
  openModal(D.modalClips);
  D.clipsBody.innerHTML = '<div class="modal-loading">Loading…</div>';

  try {
    const res   = await fetch('/api/clips');
    const clips = await res.json();

    if (!clips.length) {
      D.clipsBody.innerHTML = '<div class="no-clips">No server-side clips yet. Use the ⏺ button to record from your browser.</div>';
      return;
    }

    D.clipsBody.innerHTML = clips.map(c => `
      <div class="clip-item" data-name="${esc(c.name)}">
        <div class="clip-info">
          <div class="clip-name">${esc(c.name)}</div>
          <div class="clip-meta">${fmtBytes(c.size)} · ${new Date(c.created).toLocaleString()}</div>
        </div>
        <div class="clip-actions">
          <a href="/api/clips/${encodeURIComponent(c.name)}" download class="clip-btn">⬇ Download</a>
          <button class="clip-btn del" onclick="delClip('${esc(c.name)}', this)">✕</button>
        </div>
      </div>
    `).join('');
  } catch {
    D.clipsBody.innerHTML = '<div class="no-clips">Failed to load clips.</div>';
  }
}

window.delClip = async (name, btn) => {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await fetch(`/api/clips/${encodeURIComponent(name)}`, { method: 'DELETE' });
    btn.closest('.clip-item').remove();
    if (!D.clipsBody.querySelector('.clip-item'))
      D.clipsBody.innerHTML = '<div class="no-clips">No clips remaining.</div>';
    toast('Clip deleted');
  } catch { toast('Delete failed', 'error'); }
};

// ═══════════════════════════════════════════════════════ SHARE
function shareLink() {
  const url = location.href;
  if (navigator.share) {
    navigator.share({ title: 'Police Scanner – Live', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url)
      .then(() => toast('🔗 Link copied to clipboard', 'success'))
      .catch(() => toast('Copy failed', 'error'));
  }
}

// ═══════════════════════════════════════════════════════ STATUS UI
function updateStatus(s) {
  const dot = D.statusDot;
  dot.className = 'status-dot';
  D.statusLbl.className = 'status-lbl';

  switch (s) {
    case 'live':
      dot.classList.add('live');
      D.statusLbl.classList.add('live');
      D.statusLbl.textContent = 'LIVE';
      break;
    case 'online':
      dot.classList.add('online');
      D.statusLbl.classList.add('online');
      D.statusLbl.textContent = 'ONLINE';
      break;
    default:
      dot.classList.add('offline');
      D.statusLbl.classList.add('offline');
      D.statusLbl.textContent = 'OFFLINE';
  }
}

function setTxFlash(active) {
  D.txFlash.classList.toggle('hidden', !active);
}

// ═══════════════════════════════════════════════════════ CHANNELS
function renderChannels(channels) {
  S.channels = channels;
  D.chCount.textContent = channels.length;

  D.channelList.innerHTML = channels.map((ch, i) => `
    <div class="ch-item${ch.active ? ' active' : ''}" onclick="selectChannel(${i})" role="button" tabindex="0">
      <div class="ch-dot"></div>
      <div class="ch-info">
        <div class="ch-name">${esc(ch.name)}</div>
        <div class="ch-freq">${esc(ch.frequency ?? '')}</div>
        <div class="ch-dept">${esc(ch.department ?? '')}</div>
      </div>
    </div>
  `).join('');

  const active = channels.find(c => c.active);
  D.freqVal.textContent = active?.frequency ?? '— — — MHz';
}

window.selectChannel = i => {
  S.channels.forEach((c, j) => { c.active = (j === i); });
  renderChannels(S.channels);
};

// ═══════════════════════════════════════════════════════ VU METER
function buildVuBars(n) {
  D.vuBars.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const b = document.createElement('div');
    b.className = 'vu-bar';
    D.vuBars.appendChild(b);
  }
}

function updateVuBars(pct) {
  const bars   = D.vuBars.children;
  const n      = bars.length;
  const active = Math.round((pct / 100) * n);

  for (let i = 0; i < n; i++) {
    const frac = (i + 1) / n;
    bars[i].className = 'vu-bar' + (
      i < active
        ? frac > 0.88 ? ' on-r' : frac > 0.72 ? ' on-y' : ' on-g'
        : ''
    );
    // Animated height proportional to position
    bars[i].style.height = i < active ? `${30 + (i / n) * 70}%` : '12%';
  }
}

// ═══════════════════════════════════════════════════════ ACTIVITY LOG
function addLog(entry) {
  // Remove "waiting" placeholder
  const empty = D.activityLog.querySelector('.log-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `log-entry ${entry.type ?? 'info'}`;
  div.innerHTML = `
    <span class="log-time">${esc(fmtTime(entry.time))}</span>
    <span class="log-msg">${esc(entry.message)}</span>
  `;
  D.activityLog.insertBefore(div, D.activityLog.firstChild);

  // Cap at 120 entries
  while (D.activityLog.children.length > 120)
    D.activityLog.removeChild(D.activityLog.lastChild);
}

function clearLog() {
  D.activityLog.innerHTML = '<div class="log-empty">Log cleared.</div>';
}

// ═══════════════════════════════════════════════════════ VISUALIZER
function idleLoop() {
  const W = D.viz.width, H = D.viz.height;
  if (!W || !H) { S.idleRafId = requestAnimationFrame(idleLoop); return; }

  VC.fillStyle = '#060a0f';
  VC.fillRect(0, 0, W, H);

  const t = Date.now() / 1000;
  const bars = 64;
  const bw   = W / bars;

  for (let i = 0; i < bars; i++) {
    const v = (Math.sin(t * 1.5 + i * 0.4) * 0.5 + 0.5) * 0.12 + 0.02;
    const h = v * H;
    VC.fillStyle = `rgba(30, 90, 200, 0.35)`;
    VC.fillRect(i * bw + 1, H - h, bw - 2, h);
  }

  // Waveform idle
  WC.fillStyle = '#060a0f';
  WC.fillRect(0, 0, D.wave.width, D.wave.height);
  WC.strokeStyle = 'rgba(30,90,200,.3)';
  WC.lineWidth = 1;
  WC.beginPath();
  const WH = D.wave.height;
  for (let x = 0; x < D.wave.width; x++) {
    const y = WH / 2 + Math.sin((x / D.wave.width) * Math.PI * 4 + t * 2) * 3;
    x === 0 ? WC.moveTo(x, y) : WC.lineTo(x, y);
  }
  WC.stroke();

  S.idleRafId = requestAnimationFrame(idleLoop);
}

function vizLoop() {
  S.rafId = requestAnimationFrame(vizLoop);
  drawSpectrum();
  drawWaveform();
}

function drawSpectrum() {
  const W = D.viz.width, H = D.viz.height;
  if (!W || !H) return;

  // Get frequency data
  let freq = null;
  if (S.analyser) {
    freq = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(freq);
  }

  // Background
  VC.fillStyle = '#060a0f';
  VC.fillRect(0, 0, W, H);

  // dB grid lines
  VC.strokeStyle = 'rgba(20, 60, 160, 0.18)';
  VC.lineWidth   = 1;
  for (let i = 1; i < 4; i++) {
    const y = (H / 4) * i;
    VC.beginPath(); VC.moveTo(0, y); VC.lineTo(W, y); VC.stroke();
  }

  const bars = 80;
  const bw   = (W - bars) / bars; // gap of 1px between bars

  for (let i = 0; i < bars; i++) {
    let v;
    if (freq) {
      // Non-linear frequency mapping: emphasise low-mid freqs (voice range)
      const logIdx = Math.pow(i / bars, 1.4) * (freq.length * 0.75);
      v = freq[Math.floor(logIdx)] / 255;
    } else {
      v = 0.03;
    }

    const h  = Math.max(2, v * H * 0.95);
    const x  = i * (bw + 1);
    const y  = H - h;

    // Bar colour: green → yellow → red
    let clr;
    if (v > 0.78)      clr = `rgba(255, 60, 60, ${0.7 + v * 0.3})`;
    else if (v > 0.55) clr = `rgba(255, 170, 0, ${0.6 + v * 0.4})`;
    else               clr = `rgba(0, ${180 + v * 75}, ${80 + v * 100}, ${0.4 + v * 0.6})`;

    VC.fillStyle = clr;
    VC.fillRect(x, y, bw, h);

    // Peak dot
    if (v > 0.05) {
      VC.fillStyle = 'rgba(255,255,255,0.65)';
      VC.fillRect(x, y - 2, bw, 2);
    }

    // Mirror reflection (subtle)
    if (v > 0.08) {
      const rh = h * 0.28;
      const rg  = VC.createLinearGradient(0, H, 0, H + rh);
      rg.addColorStop(0, clr.replace(/[\d.]+\)$/, '0.22)'));
      rg.addColorStop(1, 'transparent');
      VC.fillStyle = rg;
      VC.fillRect(x, H, bw, rh);
    }
  }

  // Active-transmission glow overlay
  if (S.activeTx) {
    const grd = VC.createRadialGradient(W / 2, H, 0, W / 2, H, W * 0.65);
    grd.addColorStop(0, 'rgba(0, 255, 136, 0.06)');
    grd.addColorStop(1, 'transparent');
    VC.fillStyle = grd;
    VC.fillRect(0, 0, W, H);
  }
}

function drawWaveform() {
  const W = D.wave.width, H = D.wave.height;
  if (!W || !H) return;

  WC.fillStyle = '#060a0f';
  WC.fillRect(0, 0, W, H);

  // Centre guide
  WC.strokeStyle = 'rgba(20,60,140,.3)';
  WC.lineWidth   = 1;
  WC.beginPath(); WC.moveTo(0, H / 2); WC.lineTo(W, H / 2); WC.stroke();

  if (!S.analyser) return;

  const td = new Uint8Array(S.analyser.fftSize);
  S.analyser.getByteTimeDomainData(td);

  WC.strokeStyle = S.activeTx ? 'rgba(0, 255, 136, 0.85)' : 'rgba(26, 107, 255, 0.65)';
  WC.lineWidth   = 1.5;
  WC.beginPath();

  const step = td.length / W;
  for (let x = 0; x < W; x++) {
    const v = td[Math.floor(x * step)] / 128 - 1;
    const y = v * H * 0.46 + H / 2;
    x === 0 ? WC.moveTo(x, y) : WC.lineTo(x, y);
  }
  WC.stroke();
}

// ═══════════════════════════════════════════════════ SCANNER DATA DISPLAY

function updateScannerInfoBar(d) {
  const live = d.squelch;

  setText(D.sibSys, d.systemName  || '—', live);
  setText(D.sibGrp, d.groupName   || (d.talkgroup ? `TG ${d.talkgroup}` : '—'), live);
  setText(D.sibChn, d.channelName || '—', live);
  setText(D.sibMod, d.modulation  || '—', live);
  setText(D.sibNac, d.p25nac      || '—', false);

  // TX flash — show channel info alongside "TRANSMISSION"
  if (live) {
    const parts = [d.channelName, d.groupName, d.systemName].filter(Boolean);
    const info  = parts.join(' › ') || (d.talkgroup ? `TG ${d.talkgroup}` : '');
    if (info) {
      D.txChanInfo.textContent = info;
      D.txSep.classList.remove('hidden');
    } else {
      D.txChanInfo.textContent = '';
      D.txSep.classList.add('hidden');
    }
  }
}

function setText(el, val, highlight) {
  el.textContent = val;
  el.classList.toggle('live', highlight);
}

function updateFreqFromScanner(d) {
  if (d.frequency) {
    D.freqVal.textContent = d.frequency;
  } else if (d.talkgroup) {
    D.freqVal.textContent = `TG ${d.talkgroup}`;
  }
}

/** Highlight the channel in the sidebar list that matches what the scanner reports. */
function matchChannelInList(d) {
  const items = D.channelList.querySelectorAll('.ch-item');
  items.forEach((item, i) => {
    const ch = S.channels[i];
    if (!ch) return;

    // Match by frequency (strip spaces) or by channel/group name (case-insensitive)
    const freqMatch = ch.frequency && d.frequency &&
      ch.frequency.replace(/\s/g, '') === d.frequency.replace(/\s/g, '');
    const nameMatch =
      (d.channelName && ch.name.toLowerCase() === d.channelName.toLowerCase()) ||
      (d.groupName   && ch.name.toLowerCase() === d.groupName.toLowerCase());

    item.classList.toggle('active', (freqMatch || nameMatch) && d.squelch);
  });
}

function updateSerialDot() {
  if (!D.sibSerial) return;
  D.sibSerial.className = 'sib-serial-dot ' + (
    !S.serialEnabled   ? '' :
    S.serialConnected  ? 'online' : 'error'
  );
  D.sibSerial.title = !S.serialEnabled
    ? 'Serial: not configured'
    : S.serialConnected
      ? 'Serial: connected to BCD996XT'
      : 'Serial: offline – check USB cable';
}

// ═══════════════════════════════════════════════════════ CLOCK / UPTIME
function updateClock() {
  D.clock.textContent = new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function updateUptime() {
  if (!S.sessionStart) return;
  const s = Math.floor((Date.now() - S.sessionStart) / 1000);
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  D.sysUptime.textContent = `${h}:${m}:${sec}`;
}

// ═══════════════════════════════════════════════════════ CANVAS RESIZE
function resizeCanvases() {
  const vc = D.viz.parentElement;
  D.viz.width  = vc.clientWidth;
  D.viz.height = vc.clientHeight;

  const wc = D.wave.parentElement;
  D.wave.width  = wc.clientWidth;
  D.wave.height = wc.clientHeight;
}

// ═══════════════════════════════════════════════════════ FULLSCREEN
function toggleFs() {
  if (!document.fullscreenElement)
    document.documentElement.requestFullscreen().catch(() => {});
  else
    document.exitFullscreen().catch(() => {});
}
function onFsChange() {
  const inFs = !!document.fullscreenElement;
  D.fsPath.setAttribute('d', inFs
    ? 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z'
    : 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z'
  );
}

// ═══════════════════════════════════════════════════════ KEYBOARD
function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (D.connectScreen && !D.connectScreen.classList.contains('hidden')) return;

  switch (e.key.toLowerCase()) {
    case ' ':        e.preventDefault(); togglePlay();       break;
    case 'm':        toggleMute();                           break;
    case 'r':        toggleRecord();                         break;
    case 'c':        openClipsModal();                       break;
    case 'f':        toggleFs();                             break;
    case '?':        openModal(D.modalHelp);                 break;
    case 'escape':   closeModal(D.modalClips); closeModal(D.modalHelp); break;
    case 'arrowup':
      e.preventDefault();
      S.volume = Math.min(1, S.volume + 0.05);
      D.audio.volume = S.volume;
      D.volume.value = Math.round(S.volume * 100);
      D.volume.style.setProperty('--vol', D.volume.value + '%');
      break;
    case 'arrowdown':
      e.preventDefault();
      S.volume = Math.max(0, S.volume - 0.05);
      D.audio.volume = S.volume;
      D.volume.value = Math.round(S.volume * 100);
      D.volume.style.setProperty('--vol', D.volume.value + '%');
      break;
  }
}

// ═══════════════════════════════════════════════════════ MODAL HELPERS
function openModal(el)  { el.classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }

// ═══════════════════════════════════════════════════════ TOASTER
function toast(msg, type = '') {
  const div = document.createElement('div');
  div.className = `toast${type ? ' ' + type : ''}`;
  div.textContent = msg;
  D.toaster.appendChild(div);
  setTimeout(() => div.remove(), 3100);
}

// ═══════════════════════════════════════════════════════ UTILS
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString(); }
  catch { return iso; }
}
