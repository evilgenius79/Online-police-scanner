"""USB mic capture: open InputStream, optionally resample, yield 30 ms PCM frames."""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Iterator
from dataclasses import dataclass

import numpy as np
import sounddevice as sd
from scipy.signal import resample_poly

from . import config

log = logging.getLogger(__name__)


@dataclass
class FrameChunker:
    """Accumulates int16 mono samples and emits fixed-size byte frames."""

    frame_samples: int
    _buf: np.ndarray = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self._buf = np.empty(0, dtype=np.int16)

    def push(self, samples: np.ndarray) -> list[bytes]:
        if samples.dtype != np.int16:
            samples = samples.astype(np.int16, copy=False)
        if samples.ndim > 1:
            samples = samples[:, 0]
        self._buf = np.concatenate([self._buf, samples])
        out: list[bytes] = []
        n = self.frame_samples
        while self._buf.size >= n:
            out.append(self._buf[:n].tobytes())
            self._buf = self._buf[n:]
        return out


class Resampler:
    """Block-wise polyphase resampler. For VAD this is fine; boundary
    artifacts are below the VAD's discrimination threshold at integer ratios
    like 48k -> 16k."""

    def __init__(self, src_rate: int, dst_rate: int) -> None:
        from math import gcd
        g = gcd(src_rate, dst_rate)
        self.up = dst_rate // g
        self.down = src_rate // g
        self.identity = self.up == 1 and self.down == 1

    def __call__(self, samples: np.ndarray) -> np.ndarray:
        if self.identity:
            return samples
        # resample_poly returns float64; cast back to int16 with clipping.
        out = resample_poly(samples.astype(np.float32), self.up, self.down)
        np.clip(out, -32768, 32767, out=out)
        return out.astype(np.int16)


def list_devices() -> str:
    return str(sd.query_devices())


def _resolve_device(device: int | str | None) -> int | None:
    """Resolve a name substring to a device index. Pass-through for int/None."""
    if device is None or isinstance(device, int):
        return device
    devices = sd.query_devices()
    needle = device.lower()
    for i, d in enumerate(devices):
        if needle in d["name"].lower() and d["max_input_channels"] > 0:
            return i
    raise RuntimeError(f"no input device matched {device!r}")


def capture_frames(
    device: int | str | None = None,
    input_rate: int | None = None,
    queue_max: int = 200,
    stop: threading.Event | None = None,
) -> Iterator[bytes]:
    """Yield FRAME_BYTES-sized int16 mono frames at SAMPLE_RATE.

    Runs the PortAudio callback on its own thread; this generator owns a
    bounded queue and drops the oldest frame on overflow (logged once)."""

    device = _resolve_device(device if device is not None else config.INPUT_DEVICE)
    input_rate = input_rate or config.INPUT_SAMPLE_RATE
    resampler = Resampler(input_rate, config.SAMPLE_RATE)
    chunker = FrameChunker(config.FRAME_SAMPLES)

    q: queue.Queue[np.ndarray] = queue.Queue(maxsize=queue_max)
    overflow_logged = False

    def cb(indata, frames, time_info, status):  # noqa: ARG001
        nonlocal overflow_logged
        if status:
            log.warning("audio status: %s", status)
        try:
            q.put_nowait(indata.copy())
        except queue.Full:
            if not overflow_logged:
                log.error("capture queue full; dropping frames")
                overflow_logged = True
            try:
                q.get_nowait()
                q.put_nowait(indata.copy())
            except queue.Empty:
                pass

    # 30 ms blocks at the input rate keeps callback latency low.
    blocksize = input_rate * config.FRAME_MS // 1000

    stream = sd.InputStream(
        samplerate=input_rate,
        blocksize=blocksize,
        device=device,
        channels=config.CHANNELS,
        dtype="int16",
        callback=cb,
    )

    log.info(
        "opening input device=%s rate=%d blocksize=%d",
        device, input_rate, blocksize,
    )
    with stream:
        while stop is None or not stop.is_set():
            try:
                block = q.get(timeout=0.5)
            except queue.Empty:
                continue
            resampled = resampler(block.reshape(-1))
            for frame in chunker.push(resampled):
                yield frame
