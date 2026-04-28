"""WAV writer + PCM stats."""

from __future__ import annotations

import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

from . import config


@dataclass
class ClipStats:
    path: Path
    started_at: datetime
    duration_s: float
    peak: float   # 0.0 - 1.0 (full-scale)
    rms: float    # 0.0 - 1.0


def _pcm_stats(pcm: bytes) -> tuple[float, float]:
    arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if arr.size == 0:
        return 0.0, 0.0
    peak = float(np.max(np.abs(arr)))
    rms = float(np.sqrt(np.mean(arr * arr)))
    return peak, rms


def write_clip(pcm: bytes, frames: int, clips_dir: Path = config.CLIPS_DIR) -> ClipStats:
    started = datetime.now()
    date_dir = clips_dir / started.strftime("%Y-%m-%d")
    date_dir.mkdir(parents=True, exist_ok=True)
    path = date_dir / started.strftime("%H%M%S_%f.wav")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(config.CHANNELS)
        w.setsampwidth(config.SAMPLE_WIDTH)
        w.setframerate(config.SAMPLE_RATE)
        w.writeframes(pcm)
    peak, rms = _pcm_stats(pcm)
    duration = frames * config.FRAME_MS / 1000.0
    return ClipStats(path=path, started_at=started, duration_s=duration, peak=peak, rms=rms)
