'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { spawn }  = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch {
  config = {};
}

const PORT          = config.port           ?? 3000;
const AUDIO_DEVICE  = config.audioDevice    ?? 'hw:1,0';
const BITRATE       = config.bitrate        ?? '128k';
const SAMPLE_RATE   = config.sampleRate     ?? 44100;
const SIG_THRESHOLD = config.signalThreshold ?? -45;  // dBFS (only used when no serial)
const SILENCE_MS    = config.silenceTimeout  ?? 2000;
const CLIPS_DIR     = path.join(__dirname, 'clips');

// ── App setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────────────────────
let streamProc         = null;
let levelProc          = null;
const streamClients    = new Set();
let isLive             = false;
let signalLevel        = 0;
let activeTransmission = false;
let transmissionCount  = 0;
let silenceTimer       = null;
const startTime        = Date.now();
const activityLog      = [];

// Scanner serial state
let scannerConnected = false;
let scannerData      = null;   // latest GLG parse

// ── Helpers ───────────────────────────────────────────────────────────────────
function logActivity(type, message, extra = {}) {
  const entry = {
    id:      Date.now().toString(36) + Math.random().toString(36).slice(2),
    time:    new Date().toISOString(),
    type,
    message,
    ...extra,
  };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.length = 200;
  io.emit('activity', entry);
  return entry;
}

function broadcast(event, data) { io.emit(event, data); }

// ── Scanner Serial Integration ────────────────────────────────────────────────
let ScannerSerial;
try { ScannerSerial = require('./scanner-serial'); } catch { /* module missing */ }

let scanner = null;

if (config.scannerPort && ScannerSerial) {
  scanner = new ScannerSerial({
    scannerPort:   config.scannerPort,
    scannerBaud:   config.scannerBaud   ?? 115200,
    pollInterval:  config.pollInterval  ?? 300,
  });

  scanner.on('connected', () => {
    scannerConnected = true;
    broadcast('scannerStatus', { connected: true });
    logActivity('info', `Scanner serial connected on ${config.scannerPort}`);
  });

  scanner.on('disconnected', () => {
    scannerConnected = false;
    broadcast('scannerStatus', { connected: false });
    logActivity('warn', 'Scanner serial disconnected – retrying…');
  });

  scanner.on('error', msg => {
    logActivity('error', `Scanner serial: ${msg}`);
  });

  scanner.on('channel', data => {
    scannerData = data;
    broadcast('scanner', data);

    // Use hardware squelch as the authoritative transmission detector.
    // This replaces the ffmpeg-level VAD when serial is available.
    const wasActive = activeTransmission;

    if (data.squelch && !wasActive) {
      activeTransmission = true;
      transmissionCount++;
      const label = buildLabel(data);
      logActivity('tx', `TX: ${label}`, { count: transmissionCount, channel: data });
      broadcast('signal', { level: signalLevel, active: true });

    } else if (!data.squelch && wasActive) {
      activeTransmission = false;
      broadcast('signal', { level: signalLevel, active: false });
    }
  });

  scanner.start();
} else {
  if (config.scannerPort && !ScannerSerial) {
    console.warn('[serial] scannerPort set but serialport module not installed.');
    console.warn('[serial] Run: npm install serialport');
  } else {
    console.log('[serial] No scannerPort configured – serial integration disabled.');
  }
}

function buildLabel(d) {
  return [d.channelName, d.groupName, d.systemName, d.frequency]
    .filter(Boolean).join(' › ') || 'Unknown channel';
}

// ── Audio Stream ──────────────────────────────────────────────────────────────
function startStream() {
  if (streamProc) return;

  const args = [
    '-hide_banner', '-loglevel', 'quiet',
    '-f', 'alsa', '-i', AUDIO_DEVICE,
    '-acodec', 'libmp3lame',
    '-b:a', BITRATE,
    '-ar', String(SAMPLE_RATE),
    '-ac', '1',
    '-f', 'mp3',
    'pipe:1',
  ];

  console.log('[stream] Starting ffmpeg…');
  streamProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  streamProc.stdout.on('data', chunk => {
    for (const res of streamClients) {
      try { res.write(chunk); } catch { streamClients.delete(res); }
    }
  });

  streamProc.on('close', code => {
    console.log(`[stream] ffmpeg closed (${code}) – restarting in 3 s`);
    streamProc = null; isLive = false;
    broadcast('status', { live: false });
    setTimeout(startStream, 3000);
  });

  streamProc.on('error', err => {
    console.error('[stream] ffmpeg error:', err.message);
    streamProc = null; isLive = false;
    broadcast('status', { live: false });
    logActivity('error', `Stream error: ${err.message}`);
    setTimeout(startStream, 5000);
  });

  isLive = true;
  broadcast('status', { live: true });
  logActivity('info', 'Scanner stream started');
  console.log('[stream] Live on /stream');
}

// ── Level Monitor (ffmpeg VAD — only active when serial is NOT available) ─────
function startLevelMonitor() {
  // If we have a serial connection, the scanner's squelch signal is far more
  // accurate than dBFS analysis, so skip the second ffmpeg process.
  if (scanner) {
    console.log('[level] Serial VAD active — skipping ffmpeg level monitor');
    return;
  }

  if (levelProc) return;

  const args = [
    '-hide_banner',
    '-f', 'alsa', '-i', AUDIO_DEVICE,
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ];

  levelProc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let buf = '';
  levelProc.stderr.on('data', data => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
      if (!m) continue;

      const rms = parseFloat(m[1]);
      signalLevel = Math.max(0, Math.min(100, Math.round(((rms + 60) / 60) * 100)));

      const isActive = rms > SIG_THRESHOLD;

      if (isActive) {
        if (!activeTransmission) {
          activeTransmission = true;
          transmissionCount++;
          logActivity('tx', 'Transmission detected', { count: transmissionCount });
        }
        clearTimeout(silenceTimer); silenceTimer = null;
      } else if (activeTransmission && !silenceTimer) {
        silenceTimer = setTimeout(() => {
          activeTransmission = false; silenceTimer = null;
          broadcast('signal', { level: signalLevel, active: false });
        }, SILENCE_MS);
      }

      broadcast('signal', { level: signalLevel, active: activeTransmission });
    }
  });

  levelProc.on('close', code => {
    console.log(`[level] monitor closed (${code}) – restarting in 3 s`);
    levelProc = null;
    setTimeout(startLevelMonitor, 3000);
  });

  levelProc.on('error', err => {
    console.error('[level] error:', err.message);
    levelProc = null;
    setTimeout(startLevelMonitor, 5000);
  });
}

// ── HTTP Routes ───────────────────────────────────────────────────────────────

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  streamClients.add(res);
  broadcast('listeners', { count: streamClients.size });
  console.log(`[stream] client+ (${streamClients.size})`);

  req.on('close', () => {
    streamClients.delete(res);
    broadcast('listeners', { count: streamClients.size });
    console.log(`[stream] client- (${streamClients.size})`);
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    live: isLive,
    listeners: streamClients.size,
    signalLevel,
    activeTransmission,
    transmissionCount,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    scanner: {
      name:      config.scannerName ?? 'Police Scanner',
      location:  config.location   ?? 'Unknown',
      channels:  config.channels   ?? [],
    },
    serial: {
      enabled:   !!scanner,
      connected: scannerConnected,
      port:      config.scannerPort ?? null,
      data:      scannerData,
    },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      loadavg:  os.loadavg(),
      freemem:  os.freemem(),
      totalmem: os.totalmem(),
    },
  });
});

app.get('/api/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  res.json(activityLog.slice(0, limit));
});

app.get('/api/clips', (req, res) => {
  try {
    const files = fs.readdirSync(CLIPS_DIR)
      .filter(f => f.endsWith('.mp3'))
      .map(f => {
        const stat = fs.statSync(path.join(CLIPS_DIR, f));
        return { name: f, size: stat.size, created: stat.mtimeMs };
      })
      .sort((a, b) => b.created - a.created);
    res.json(files);
  } catch { res.json([]); }
});

app.get('/api/clips/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const fp   = path.join(CLIPS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

app.delete('/api/clips/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const fp   = path.join(CLIPS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  logActivity('info', `Clip deleted: ${name}`);
  res.json({ ok: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('init', {
    live:              isLive,
    listeners:         streamClients.size,
    signalLevel,
    activeTransmission,
    transmissionCount,
    uptime:            Math.floor((Date.now() - startTime) / 1000),
    log:               activityLog.slice(0, 30),
    scanner: {
      name:     config.scannerName ?? 'Police Scanner',
      location: config.location   ?? 'Unknown',
      channels: config.channels   ?? [],
    },
    serial: {
      enabled:   !!scanner,
      connected: scannerConnected,
      port:      config.scannerPort ?? null,
      data:      scannerData,
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚔  Police Scanner web server`);
  console.log(`    http://0.0.0.0:${PORT}\n`);
  startStream();
  startLevelMonitor();
});
