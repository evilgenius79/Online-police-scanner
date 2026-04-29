'use strict';

/**
 * Uniden BCD996XT serial interface.
 *
 * Polls the GLG command every ~300 ms and emits 'channel' events with
 * parsed data. Handles reconnection automatically if the port disappears.
 *
 * Events emitted:
 *   'connected'          – serial port opened successfully
 *   'disconnected'       – port closed or errored
 *   'channel', data      – parsed GLG response (see parseGLG)
 *   'idle'               – scanner returned empty GLG (scanning / no signal)
 *   'error', err         – non-fatal error string
 */

const { EventEmitter } = require('events');
const { SerialPort }   = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// GLG response field indices
const F = {
  CMD:      0,
  FRQ_TGID: 1,
  MOD:      2,
  ATT:      3,
  CTCSS:    4,
  SYS_NAME: 5,
  GRP_NAME: 6,
  CHN_NAME: 7,
  SQUELCH:  8,
  MUTED:    9,
  SYS_TAG:  10,
  CHAN_TAG:  11,
  P25_NAC:  12,
};

class ScannerSerial extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.path        = cfg.scannerPort    ?? '/dev/ttyUSB0';
    this.baudRate    = cfg.scannerBaud    ?? 115200;
    this.pollMs      = cfg.pollInterval   ?? 300;
    this._port       = null;
    this._pollTimer  = null;
    this._reconnTimer = null;
    this.connected   = false;
    this.lastChannel = null;   // most recent non-idle GLG parse
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start() {
    console.log(`[scanner-serial] Starting on ${this.path} @ ${this.baudRate}`);
    this._connect();
  }

  stop() {
    clearTimeout(this._reconnTimer);
    this._reconnTimer = null;
    this._teardown();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _connect() {
    if (this._port) return;

    const port = new SerialPort({
      path:      this.path,
      baudRate:  this.baudRate,
      dataBits:  8,
      parity:    'none',
      stopBits:  1,
      autoOpen:  false,
    });

    const parser = port.pipe(new ReadlineParser({ delimiter: '\r' }));
    parser.on('data', line => this._handleLine(line.trim()));

    port.on('error', err => {
      this.emit('error', err.message);
      console.error('[scanner-serial] Error:', err.message);
      this._teardown();
      this._scheduleReconnect();
    });

    port.on('close', () => {
      console.log('[scanner-serial] Port closed');
      this.connected = false;
      this.emit('disconnected');
      this._teardown();
      this._scheduleReconnect();
    });

    port.open(err => {
      if (err) {
        console.warn(`[scanner-serial] Cannot open ${this.path}: ${err.message}`);
        this._teardown();
        this._scheduleReconnect();
        return;
      }

      this._port = port;
      this.connected = true;
      console.log(`[scanner-serial] Connected on ${this.path}`);
      this.emit('connected');

      // Verify we're talking to a Uniden scanner
      port.write('MDL\r');
      this._startPolling();
    });
  }

  _teardown() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this._port?.isOpen) {
      try { this._port.close(); } catch { /* ignore */ }
    }
    this._port = null;
    this.connected = false;
  }

  _scheduleReconnect() {
    if (this._reconnTimer) return;
    console.log('[scanner-serial] Reconnecting in 5 s…');
    this._reconnTimer = setTimeout(() => {
      this._reconnTimer = null;
      this._connect();
    }, 5000);
  }

  _startPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      if (this._port?.isOpen) {
        this._port.write('GLG\r', err => {
          if (err) console.warn('[scanner-serial] Write error:', err.message);
        });
      }
    }, this.pollMs);
  }

  _handleLine(line) {
    // Model confirmation
    if (line.startsWith('MDL,')) {
      console.log('[scanner-serial] Model:', line.split(',')[1]);
      return;
    }

    if (!line.startsWith('GLG,')) return;

    const f = line.split(',');
    const raw = f[F.FRQ_TGID] ?? '';

    if (!raw) {
      // Scanner is idle / scanning between channels
      this.emit('idle');
      // Emit a channel event with squelch=false so the server can close the TX
      if (this.lastChannel) {
        this.emit('channel', { ...this.lastChannel, squelch: false });
      }
      return;
    }

    const isFreq = raw.length === 8 && /^\d+$/.test(raw);

    const data = {
      frequency:   isFreq  ? formatFreq(raw) : null,
      talkgroup:   !isFreq ? raw             : null,
      modulation:  f[F.MOD]      ?? '',
      attenuation: f[F.ATT]      === '1',
      ctcss:       normCtcss(f[F.CTCSS]),
      systemName:  f[F.SYS_NAME] ?? '',
      groupName:   f[F.GRP_NAME] ?? '',
      channelName: f[F.CHN_NAME] ?? '',
      squelch:     f[F.SQUELCH]  === '1',
      muted:       f[F.MUTED]    === '1',
      sysTag:      normTag(f[F.SYS_TAG]),
      chanTag:     normTag(f[F.CHAN_TAG]),
      p25nac:      normNac(f[F.P25_NAC]),
    };

    this.lastChannel = data;
    this.emit('channel', data);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 8-digit 100Hz integer → "462.5000 MHz" */
function formatFreq(raw) {
  return (parseInt(raw, 10) / 10000).toFixed(4) + ' MHz';
}

/** CTCSS/DCS field: '0' or '127' mean none */
function normCtcss(v) {
  if (!v || v === '0' || v === '127') return null;
  return v;
}

/** Tag fields: 'NONE' → null */
function normTag(v) {
  return (!v || v === 'NONE') ? null : v;
}

/** P25 NAC: 'NONE' → null */
function normNac(v) {
  return (!v || v === 'NONE') ? null : v;
}

module.exports = ScannerSerial;
