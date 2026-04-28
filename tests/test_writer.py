"""WAV writer + DB integration."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from scanner import config, db, writer


def test_write_clip_creates_valid_wav(tmp_path: Path):
    clips = tmp_path / "clips"
    # 1 s of a 440 Hz tone at -6 dBFS.
    n = config.SAMPLE_RATE
    t = np.arange(n) / config.SAMPLE_RATE
    tone = (0.5 * 32767 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    pcm = tone.tobytes()
    frames = n // config.FRAME_SAMPLES

    stats = writer.write_clip(pcm, frames, clips_dir=clips)

    assert stats.path.exists()
    assert stats.path.suffix == ".wav"
    with wave.open(str(stats.path), "rb") as w:
        assert w.getframerate() == config.SAMPLE_RATE
        assert w.getnchannels() == config.CHANNELS
        assert w.getsampwidth() == config.SAMPLE_WIDTH
        assert w.getnframes() == n

    assert 0.0 < stats.rms < stats.peak <= 1.0
    assert stats.duration_s == frames * config.FRAME_MS / 1000.0


def test_db_roundtrip(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "scanner.db")

    conn = db.connect()
    cid = db.insert_clip(
        conn,
        path="clips/2026-04-28/120000_000000.wav",
        started_at=1735689600.0,
        duration_s=3.5,
        peak=0.8,
        rms=0.2,
    )
    rows = db.list_clips(conn)
    assert len(rows) == 1 and rows[0]["id"] == cid

    db.update_notes(conn, cid, "traffic stop on main")
    found = db.search_clips(conn, "traffic")
    assert len(found) == 1 and found[0]["id"] == cid
    assert db.search_clips(conn, "fire") == []

    deleted = db.delete_clip(conn, cid)
    assert deleted is not None
    assert db.list_clips(conn) == []
