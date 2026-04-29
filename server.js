'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Config ──────────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch {
  config = {};
}

const PORT           = config.port           ?? 3000;
const AUDIO_DEVICE   = config.audioDevice    ?? 'hw:1,0';
const BITRATE        = config.bitrate        ?? '128k';
const SAMPLE_RATE    = config.sampleRate     ?? 44100;
const SIG_THRESHOLD  = config.signalThreshold ?? -45;   // dBFS — above = active transmission
const SILENCE_MS     = config.silenceTimeout  ?? 2000;  // ms of silence before ending transmission
const CLIPS_DIR      = path.join(__dirname, 'clips');

// ── App setup ────────────────────────────────────────────────────────────────
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
let streamProc        = null;
let levelProc         = null;
const streamClients   = new Set();
let isLive            = false;
let signalLevel       = 0;        // 0–100
let activeTransmission = false;
let transmissionCount  = 0;
let silenceTimer       = null;
const startTime        = Date.now();
const activityLog      = [];       // newest first, max 200

// ── Helpers ──────────────────────────────────────────────────────────────────
function logActivity(type, message, extra = {}) {
  const entry = {
    id:      Date.now().toString(36) + Math.random().toString(36).slice(2),
    time:    new Date().toISOString(),
    type,    // 'tx' | 'info' | 'warn' | 'error'
    message,
    ...extra,
  };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.length = 200;
  io.emit('activity', entry);
  return entry;
}

function broadcast(event, data) { io.emit(event, data); }

// ── Audio stream (ffmpeg → MP3 → HTTP chunked) ────────────────────────────────
function startStream() {
  if (streamProc) return;

  const args = [
    '-hide_banner', '-loglevel', 'quiet',
    '-f', 'alsa', '-i', AUDIO_DEVICE,
    '-acodec', 'libmp3lame',
    '-b:a',  BITRATE,
    '-ar',   String(SAMPLE_RATE),
    '-ac',   '1',
    '-f',    'mp3',
    'pipe:1',
  ];

  console.log('[stream] Starting:', 'ffmpeg', args.join(' '));
  streamProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  streamProc.stdout.on('data', chunk => {
    for (const res of streamClients) {
      try { res.write(chunk); } catch { streamClients.delete(res); }
    }
  });

  streamProc.on('close', code => {
    console.log(`[stream] closed (code ${code}) – restarting in 3 s`);
    streamProc = null;
    isLive     = false;
    broadcast('status', { live: false });
    setTimeout(startStream, 3000);
  });

  streamProc.on('error', err => {
    console.error('[stream] error:', err.message);
    streamProc = null;
    isLive     = false;
    broadcast('status', { live: false });
    logActivity('error', `Stream error: ${err.message}`);
    setTimeout(startStream, 5000);
  });

  isLive = true;
  broadcast('status', { live: true });
  logActivity('info', 'Scanner stream started');
  console.log('[stream] Live on /stream');
}

// ── Level monitor (separate ffmpeg → astats → stderr parsing) ────────────────
function startLevelMonitor() {
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
      // Map [-60, 0] dBFS → [0, 100]
      signalLevel = Math.max(0, Math.min(100, Math.round(((rms + 60) / 60) * 100)));

      const isActive = rms > SIG_THRESHOLD;

      if (isActive) {
        if (!activeTransmission) {
          activeTransmission = true;
          transmissionCount++;
          logActivity('tx', 'Transmission detected', { count: transmissionCount });
        }
        clearTimeout(silenceTimer);
        silenceTimer = null;
      } else if (activeTransmission && !silenceTimer) {
        silenceTimer = setTimeout(() => {
          activeTransmission = false;
          silenceTimer       = null;
          broadcast('signal', { level: signalLevel, active: false });
        }, SILENCE_MS);
      }

      broadcast('signal', { level: signalLevel, active: activeTransmission });
    }
  });

  levelProc.on('close', code => {
    console.log(`[level] closed (code ${code}) – restarting in 3 s`);
    levelProc = null;
    setTimeout(startLevelMonitor, 3000);
  });

  levelProc.on('error', err => {
    console.error('[level] error:', err.message);
    levelProc = null;
    setTimeout(startLevelMonitor, 5000);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Live MP3 stream
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

// Status / health
app.get('/api/status', (req, res) => {
  res.json({
    live: isLive,
    listeners: streamClients.size,
    signalLevel,
    activeTransmission,
    transmissionCount,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    scanner: {
      name:     config.scannerName ?? 'Police Scanner',
      location: config.location   ?? 'Unknown',
      channels: config.channels   ?? [],
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

// Activity log
app.get('/api/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  res.json(activityLog.slice(0, limit));
});

// Clips list
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
  } catch {
    res.json([]);
  }
});

// Serve individual clip
app.get('/api/clips/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const fp   = path.join(CLIPS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

// Delete clip
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
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚔  Police Scanner web server`);
  console.log(`    http://0.0.0.0:${PORT}\n`);
  startStream();
  startLevelMonitor();
});
