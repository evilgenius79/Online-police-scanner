"""End-to-end capture pipeline: USB mic -> VAD -> WAV file + DB row."""

from __future__ import annotations

import logging
import threading

from . import audio, config, db, vad, writer

log = logging.getLogger(__name__)


def run(stop: threading.Event | None = None) -> None:
    """Blocks until `stop` is set (or forever). Safe to run in a thread."""
    stop = stop or threading.Event()
    conn = db.connect()
    config.CLIPS_DIR.mkdir(parents=True, exist_ok=True)

    def on_clip(pcm: bytes, frames: int) -> None:
        try:
            stats = writer.write_clip(pcm, frames)
            db.insert_clip(
                conn,
                path=str(stats.path.relative_to(config.DATA_DIR)),
                started_at=stats.started_at.timestamp(),
                duration_s=stats.duration_s,
                peak=stats.peak,
                rms=stats.rms,
            )
            log.info(
                "clip %s  %.1fs  peak=%.2f rms=%.3f",
                stats.path.name, stats.duration_s, stats.peak, stats.rms,
            )
        except Exception:
            log.exception("failed to write clip")

    slicer = vad.VADSlicer(on_clip)
    log.info("pipeline started")
    try:
        for frame in audio.capture_frames(stop=stop):
            slicer.process(frame)
    finally:
        slicer.flush()
        conn.close()
        log.info("pipeline stopped")
