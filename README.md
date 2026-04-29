# 🚔 Online Police Scanner

A sleek, real-time web interface for a hardware police scanner, built to run on an **Orange Pi 4 Pro** (or any Linux SBC with ALSA audio input).

---

## Screenshots

### Connect Screen
> The landing page visitors see before audio starts — required by browsers before playing audio.

![Connect screen](docs/screenshot-connect.png)

### Live Scanner Dashboard
> Full dashboard with spectrum analyzer, channels, signal meter, activity log, and controls.

![Main dashboard](docs/screenshot-main.png)

> The spectrum analyzer (center) fills with animated frequency bars once the scanner is connected and transmitting. The waveform strip runs along the bottom. The activity log on the right shows every detected transmission with a timestamp.

---

## Features

| | Feature | Description |
|---|---|---|
| 🔴 | Live audio stream | Real-time MP3 from your physical scanner over HTTP |
| 📊 | Spectrum analyzer | 80-bar FFT canvas with peak dots and mirror reflection |
| 〰️ | Waveform display | Time-domain oscilloscope strip |
| 📡 | Signal meter | 24-bar VU meter, color-coded green → amber → red |
| ⚡ | Transmission alerts | Voice activity detection — flashes red banner in header |
| 📋 | Activity log | Timestamped log of every detected transmission |
| 👂 | Listener count | Live count of connected clients |
| ⏺ | Browser recording | One-click clip capture, saved to your Downloads folder |
| 📂 | Server clips | Browse and download clips saved on the server |
| 📻 | Channel panel | Configurable channel list with frequency labels |
| ⌨️ | Keyboard shortcuts | Space, M, R, C, F, ↑↓, ? |
| 📱 | Responsive | Adapts from desktop down to mobile |
| 🔗 | Share button | Copies URL or triggers native share sheet on mobile |
| 🖥️ | Fullscreen | Immersive kiosk-friendly mode |

---

## Requirements

- **Node.js ≥ 18**
- **ffmpeg** with `libmp3lame` support
- An audio input device (3.5mm, USB audio adapter, etc.)
- Linux with ALSA — tested on Orange Pi 4 Pro with Armbian

---

## Quick Start

```bash
# 1. Install Node.js and ffmpeg
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs ffmpeg

# 2. Clone and install
git clone https://github.com/evilgenius79/online-police-scanner.git
cd online-police-scanner
npm install

# 3. Find your scanner's audio device
arecord -l
# Example output: "card 1, device 0" → use hw:1,0

# 4. Edit config.json (set audioDevice, name, location, channels)
nano config.json

# 5. Start
npm start
# → Open http://<your-pi-ip>:3000 in any browser
```

---

## Configuration (`config.json`)

```jsonc
{
  "port": 3000,
  "audioDevice": "hw:1,0",       // from arecord -l
  "bitrate": "128k",              // MP3 stream bitrate
  "sampleRate": 44100,

  "signalThreshold": -45,         // dBFS above which = active transmission
  "silenceTimeout": 2000,         // ms of silence before ending a transmission

  "scannerName": "City Police Scanner",
  "location": "Your City, State",

  "channels": [
    {
      "id": 1,
      "name": "Police Dispatch",
      "frequency": "155.340 MHz",
      "department": "City PD",
      "active": true
    },
    {
      "id": 2,
      "name": "Fire / EMS",
      "frequency": "154.295 MHz",
      "department": "Fire Dept",
      "active": false
    }
  ]
}
```

---

## Run as a systemd Service (Auto-start on Boot)

```bash
# Copy files to /opt/police-scanner
sudo mkdir /opt/police-scanner
sudo cp -r . /opt/police-scanner
sudo npm --prefix /opt/police-scanner install --omit=dev

# Create a dedicated user in the audio group
sudo useradd -r -s /bin/false -G audio scanner

# Install and enable the service
sudo cp systemd/scanner-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scanner-web

# Check status and logs
sudo systemctl status scanner-web
journalctl -fu scanner-web
```

---

## Architecture

```
[Police Scanner hardware]
        │ 3.5mm / USB audio
        ▼
[Orange Pi 4 Pro — ALSA]
        │
   ┌────┴────────────────────────────────────┐
   │              server.js                  │
   │                                         │
   │  ┌─────────────┐   GET /stream          │──► Browser 1
   │  │ ffmpeg MP3  │──► HTTP chunked MP3 ───│──► Browser 2
   │  │   stream    │                        │──► Browser N
   │  └─────────────┘                        │
   │  ┌─────────────┐   Socket.io events     │
   │  │ ffmpeg level│──► signal / activity ──│──► All browsers
   │  │   monitor   │   (VAD detection)      │
   │  └─────────────┘                        │
   └─────────────────────────────────────────┘
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/stream` | Live MP3 audio stream |
| `GET` | `/api/status` | JSON — live status, listeners, signal, system info |
| `GET` | `/api/log?limit=50` | Recent activity log entries |
| `GET` | `/api/clips` | List server-side recorded clips |
| `GET` | `/api/clips/:name` | Download a clip |
| `DELETE` | `/api/clips/:name` | Delete a clip |

### Socket.io Events (server → client)

| Event | Payload | Description |
|---|---|---|
| `init` | full state object | Sent immediately on connect |
| `status` | `{ live }` | Stream came up or went down |
| `signal` | `{ level, active }` | Audio level (0–100) + VAD active flag |
| `listeners` | `{ count }` | Listener count changed |
| `activity` | log entry | New transmission or info event |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause stream |
| `M` | Toggle mute |
| `R` | Start / stop recording |
| `C` | Open clip library |
| `F` | Toggle fullscreen |
| `↑ / ↓` | Volume up / down |
| `?` | Show keyboard shortcuts |
| `Esc` | Close dialog |
