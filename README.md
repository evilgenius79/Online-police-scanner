# 🚔 Online Police Scanner

A sleek, real-time web interface for a hardware police scanner running on **Orange Pi 4 Pro** (or any Linux SBC).

![Dark scanner UI with spectrum analyzer, activity log, and channel list](https://placeholder)

## Features

| Feature | Description |
|---|---|
| 🔴 Live stream | Real-time MP3 audio from your physical scanner via HTTP |
| 📊 Spectrum analyzer | Canvas-based FFT visualizer with peak hold |
| 〰️ Waveform display | Time-domain oscilloscope view |
| 📡 Signal meter | 24-bar VU meter with green/amber/red zones |
| ⚡ Transmission alerts | Auto-detects active voice (VAD), flashes header banner |
| 📋 Activity log | Timestamped log of all transmissions |
| 👂 Listener count | Live count of connected clients via Socket.io |
| ⏺ Browser recording | One-click WebM clip capture, saved to Downloads |
| 📂 Server-side clips | Browse and download clips saved on the server |
| 📻 Channel display | Configurable channel list with frequency labels |
| ⌨️ Keyboard shortcuts | Space, M, R, C, F, ?, ↑↓ volume |
| 📱 Responsive | Adapts from desktop to mobile |
| 🔗 Share button | Copy URL or use native share sheet on mobile |
| 🖥️ Fullscreen mode | Immersive kiosk-friendly view |

---

## Requirements

- **Node.js ≥ 18**
- **ffmpeg** with `libmp3lame` support
- Audio input (3.5mm, USB audio adapter, etc.)
- Linux (ALSA) — tested on Orange Pi 4 Pro with Armbian

---

## Quick Start

```bash
# 1. Install Node.js (if needed)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs ffmpeg

# 2. Install dependencies
npm install

# 3. Find your audio device
arecord -l          # list capture devices  e.g. "card 1, device 0" → hw:1,0

# 4. Edit config.json
nano config.json    # set audioDevice, scannerName, location, channels

# 5. Start
npm start
# → http://localhost:3000
```

---

## Configuration (`config.json`)

```jsonc
{
  "port": 3000,
  "audioDevice": "hw:1,0",      // ALSA device (from arecord -l)
  "bitrate": "128k",             // MP3 stream bitrate
  "sampleRate": 44100,

  "signalThreshold": -45,        // dBFS above which = active transmission
  "silenceTimeout": 2000,        // ms of silence before ending a transmission

  "scannerName": "City Police Scanner",
  "location": "Your City, State",

  "channels": [
    {
      "id": 1,
      "name": "Police Dispatch",
      "frequency": "155.340 MHz",
      "department": "City PD",
      "active": true
    }
  ]
}
```

---

## Run as a systemd Service

```bash
# Copy files to /opt/police-scanner
sudo mkdir /opt/police-scanner
sudo cp -r . /opt/police-scanner
sudo npm --prefix /opt/police-scanner install

# Create service user
sudo useradd -r -s /bin/false -G audio scanner

# Install service
sudo cp systemd/scanner-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scanner-web

# Logs
journalctl -fu scanner-web
```

---

## Architecture

```
[Police Scanner] ──3.5mm──> [Orange Pi 4 Pro ALSA]
                                     │
                           ┌─────────┴──────────┐
                           │     server.js        │
                           │  (Express + Socket.io)│
                           │                      │
                           │  ┌──────────────┐    │
                           │  │ ffmpeg stream │    │  → GET /stream (MP3 chunked HTTP)
                           │  └──────────────┘    │
                           │  ┌──────────────┐    │
                           │  │ level monitor │    │  → Socket.io signal events
                           │  └──────────────┘    │
                           └──────────┬───────────┘
                                      │
                              [ Browser clients ]
                              Web Audio API + Canvas
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/stream` | Live MP3 audio stream |
| `GET` | `/api/status` | JSON status (live, listeners, signal, etc.) |
| `GET` | `/api/log` | Recent activity log entries |
| `GET` | `/api/clips` | List server-side recorded clips |
| `GET` | `/api/clips/:name` | Download a clip |
| `DELETE` | `/api/clips/:name` | Delete a clip |

## Socket.io Events (server → client)

| Event | Payload | Description |
|---|---|---|
| `init` | full state | Sent on first connect |
| `status` | `{live}` | Stream up/down |
| `signal` | `{level, active}` | Audio level (0–100) + VAD flag |
| `listeners` | `{count}` | Listener count changed |
| `activity` | log entry | New activity log entry |
