"""Runtime configuration. Override via environment variables prefixed with SCANNER_."""

from __future__ import annotations

import os
from pathlib import Path

# --- Audio format ---------------------------------------------------------
# webrtcvad accepts 8/16/32/48 kHz mono int16 frames of 10/20/30 ms.
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes per sample (int16)
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 480
FRAME_BYTES = FRAME_SAMPLES * SAMPLE_WIDTH      # 960

# --- VAD ------------------------------------------------------------------
# 0=least, 3=most aggressive at filtering non-speech. 2 is a good middle for
# squelched scanner audio (clean silence between transmissions).
VAD_AGGRESSIVENESS = 2

SPEECH_FRAMES_TRIGGER = 5     # ~150 ms speech to start a clip
SILENCE_FRAMES_END = 67       # ~2.0 s silence ends a clip
PRE_ROLL_FRAMES = 17          # ~0.5 s saved before trigger
POST_ROLL_FRAMES = 10         # ~0.3 s kept after end-of-speech
MIN_CLIP_FRAMES = 17          # drop clips shorter than ~0.5 s
MAX_CLIP_FRAMES = 4000        # hard cap at 120 s

# --- Storage --------------------------------------------------------------
DATA_DIR = Path(os.environ.get("SCANNER_DATA_DIR", "."))
CLIPS_DIR = DATA_DIR / "clips"
DB_PATH = DATA_DIR / "scanner.db"

# --- Audio device ---------------------------------------------------------
# None -> PortAudio default. Set to int index (see `scanner devices`) or
# substring of the device name.
INPUT_DEVICE: int | str | None = (
    int(os.environ["SCANNER_INPUT_DEVICE"])
    if os.environ.get("SCANNER_INPUT_DEVICE", "").lstrip("-").isdigit()
    else os.environ.get("SCANNER_INPUT_DEVICE") or None
)

# Native rate to open the input at. If different from SAMPLE_RATE, the
# capture loop resamples down. Most USB audio class devices support 16000
# directly; 48000 is a safe fallback for cards that don't.
INPUT_SAMPLE_RATE = int(os.environ.get("SCANNER_INPUT_RATE", str(SAMPLE_RATE)))

# --- Web ------------------------------------------------------------------
WEB_HOST = os.environ.get("SCANNER_WEB_HOST", "127.0.0.1")
WEB_PORT = int(os.environ.get("SCANNER_WEB_PORT", "8000"))

# --- Logging --------------------------------------------------------------
LOG_LEVEL = os.environ.get("SCANNER_LOG_LEVEL", "INFO")
