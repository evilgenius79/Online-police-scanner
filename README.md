# Online Police Scanner

VAD-based scanner-audio recorder with a tiny web UI. Designed for an Orange Pi
4 Pro (Allwinner A733, aarch64) fed by a USB sound card or USB mic plugged
into a discriminator / line-out from your scanner.

## What it does

1. Captures mono 16 kHz / 16-bit PCM from a USB input via PortAudio.
2. Splits the stream into 30 ms frames and runs WebRTC VAD on each.
3. When ~150 ms of voice is seen, opens a clip with ~0.5 s of pre-roll.
4. When ~2 s of silence follows, closes the clip with ~0.3 s of post-roll.
5. Writes the clip as a WAV under `clips/YYYY-MM-DD/HHMMSS_ffffff.wav` and
   indexes it (path, time, duration, peak, RMS, notes) in SQLite + FTS5.
6. Serves a small FastAPI page to browse, play, search-by-notes and delete
   clips on your LAN.

## Quick start (Orange Pi 4 Pro / Armbian / Ubuntu)

```bash
git clone <this repo> Online-police-scanner
cd Online-police-scanner
./scripts/install.sh
# log out / back in once for the audio group to take effect

source .venv/bin/activate
python -m scanner devices                  # find your USB input index
SCANNER_INPUT_DEVICE=1 python -m scanner run
# browse at http://<pi-ip>:8000
```

If your USB device doesn't support 16 kHz natively, set
`SCANNER_INPUT_RATE=48000` and the capture loop will downsample with
`scipy.signal.resample_poly`.

## Run as a service

```bash
sudo cp systemd/scanner.service /etc/systemd/system/
sudoedit /etc/systemd/system/scanner.service   # set User, paths, device idx
sudo systemctl daemon-reload
sudo systemctl enable --now scanner
journalctl -u scanner -f
```

## Configuration

All knobs live in `scanner/config.py`. The audio + VAD constants are tuned
for squelched scanner audio (clean silence between transmissions); change
`VAD_AGGRESSIVENESS` (0–3) first if you get false triggers or missed clips.

| env var                  | default     | meaning                                    |
| ------------------------ | ----------- | ------------------------------------------ |
| `SCANNER_DATA_DIR`       | `.`         | parent for `clips/` and `scanner.db`       |
| `SCANNER_INPUT_DEVICE`   | unset       | PortAudio index or name substring          |
| `SCANNER_INPUT_RATE`     | `16000`     | native input rate; resampled if != 16000   |
| `SCANNER_WEB_HOST`       | `127.0.0.1` | bind address (set to `0.0.0.0` for LAN)    |
| `SCANNER_WEB_PORT`       | `8000`      | web port                                   |
| `SCANNER_LOG_LEVEL`      | `INFO`      | python logging level                       |

## Hardware notes

- Disable hardware AGC on the USB device if possible — AGC during squelched
  silence will inflate noise and confuse the VAD.
- A line-level feed from the scanner's discriminator/tape-out is far better
  than an open mic in the room.
- USB audio class devices appear under PortAudio; `python -m scanner
  devices` lists them. If you don't see your card, check `arecord -l` and
  that your user is in the `audio` group.

## Maintenance

```bash
python scripts/prune_clips.py --days 30 --dry-run
python scripts/prune_clips.py --days 30
```

## Layout

```
scanner/
  config.py     # constants + env overrides
  audio.py      # InputStream + resampler + frame chunker
  vad.py        # VADSlicer state machine
  writer.py     # WAV writer + PCM stats
  db.py         # SQLite + FTS5 schema and helpers
  pipeline.py   # mic -> VAD -> file + db
  cli.py        # devices | capture | serve | run
  web/app.py    # FastAPI UI + JSON API
scripts/
  install.sh
  prune_clips.py
systemd/
  scanner.service
tests/          # unit tests for VAD + writer + DB
```

## Tests

```bash
pip install pytest
pytest -q
```

The VAD tests stub `webrtcvad` so they run anywhere; the audio capture
itself is hardware-dependent and not covered by automated tests.
