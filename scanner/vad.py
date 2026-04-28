"""WebRTC VAD-based clip slicer with pre-roll/post-roll."""

from __future__ import annotations

import collections
from collections.abc import Callable

import webrtcvad

from . import config


class VADSlicer:
    """Stateful slicer. Feed 30 ms PCM frames; on_clip is called with
    concatenated bytes whenever a complete clip is emitted.

    State machine:
      IDLE     -> SPEAKING when SPEECH_FRAMES_TRIGGER consecutive voiced
                  frames seen (pre-roll attached on transition).
      SPEAKING -> IDLE     when SILENCE_FRAMES_END consecutive silent
                  frames seen, OR clip hits MAX_CLIP_FRAMES.
    """

    def __init__(self, on_clip: Callable[[bytes, int], None]) -> None:
        self.vad = webrtcvad.Vad(config.VAD_AGGRESSIVENESS)
        self.on_clip = on_clip
        self._preroll: collections.deque[bytes] = collections.deque(
            maxlen=config.PRE_ROLL_FRAMES,
        )
        self._buf: list[bytes] = []
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0

    def process(self, frame: bytes) -> None:
        if len(frame) != config.FRAME_BYTES:
            raise ValueError(
                f"frame must be {config.FRAME_BYTES} bytes, got {len(frame)}",
            )
        is_speech = self.vad.is_speech(frame, config.SAMPLE_RATE)

        if not self._in_speech:
            self._preroll.append(frame)
            if is_speech:
                self._speech_run += 1
                if self._speech_run >= config.SPEECH_FRAMES_TRIGGER:
                    self._in_speech = True
                    self._buf = list(self._preroll)
                    self._silence_run = 0
                    self._speech_run = 0
            else:
                self._speech_run = 0
            return

        # In speech.
        self._buf.append(frame)
        if is_speech:
            self._silence_run = 0
        else:
            self._silence_run += 1
            if self._silence_run >= config.SILENCE_FRAMES_END:
                self._emit(trim_silence=True)
                return
        if len(self._buf) >= config.MAX_CLIP_FRAMES:
            self._emit(trim_silence=False)

    def flush(self) -> None:
        """Emit any in-progress clip (e.g. on shutdown)."""
        if self._in_speech and self._buf:
            self._emit(trim_silence=True)

    def _emit(self, *, trim_silence: bool) -> None:
        buf = self._buf
        if trim_silence and self._silence_run > config.POST_ROLL_FRAMES:
            drop = self._silence_run - config.POST_ROLL_FRAMES
            buf = buf[:-drop]
        if len(buf) >= config.MIN_CLIP_FRAMES:
            self.on_clip(b"".join(buf), len(buf))
        self._reset()

    def _reset(self) -> None:
        self._in_speech = False
        self._buf = []
        self._preroll.clear()
        self._speech_run = 0
        self._silence_run = 0
