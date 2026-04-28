"""VADSlicer state-machine tests with a scripted fake VAD."""

from __future__ import annotations

import sys
import types

import pytest


# Stub webrtcvad before scanner.vad imports it -- avoids needing the C wheel
# in CI/test environments.
class _FakeVad:
    queue: list[bool] = []

    def __init__(self, _aggressiveness: int) -> None:
        pass

    def is_speech(self, _frame: bytes, _rate: int) -> bool:
        return _FakeVad.queue.pop(0) if _FakeVad.queue else False


_fake_mod = types.ModuleType("webrtcvad")
_fake_mod.Vad = _FakeVad  # type: ignore[attr-defined]
sys.modules["webrtcvad"] = _fake_mod

from scanner import config, vad  # noqa: E402

FRAME = b"\x00\x00" * config.FRAME_SAMPLES  # 960 silent bytes


def _drive(seq: list[bool]) -> list[tuple[bytes, int]]:
    """Run a scripted speech/silence sequence through the slicer; return clips."""
    _FakeVad.queue = list(seq)
    out: list[tuple[bytes, int]] = []
    slicer = vad.VADSlicer(lambda b, n: out.append((b, n)))
    for _ in seq:
        slicer.process(FRAME)
    slicer.flush()
    return out


def test_short_chirp_is_dropped():
    # Trigger fires (5 voiced) then immediately ends (67 silent),
    # but post-trim drops to <MIN_CLIP_FRAMES so nothing emits.
    seq = [True] * config.SPEECH_FRAMES_TRIGGER + [False] * config.SILENCE_FRAMES_END
    assert _drive(seq) == []


def test_clip_emits_with_pre_and_post_roll():
    speech_n = 30  # well above trigger; clip body
    seq = (
        [False] * (config.PRE_ROLL_FRAMES + 5)  # noise in pre-roll buffer
        + [True] * speech_n
        + [False] * config.SILENCE_FRAMES_END
    )
    clips = _drive(seq)
    assert len(clips) == 1
    pcm, frames = clips[0]
    # Expected length: PRE_ROLL_FRAMES (preroll snapshot at trigger) +
    #   (speech_n - SPEECH_FRAMES_TRIGGER)  -- frames pushed into buf during SPEAKING
    #   + SILENCE_FRAMES_END                -- silence pushed in
    #   - (SILENCE_FRAMES_END - POST_ROLL_FRAMES)  -- trimmed back to post-roll
    expected = (
        config.PRE_ROLL_FRAMES
        + (speech_n - config.SPEECH_FRAMES_TRIGGER)
        + config.POST_ROLL_FRAMES
    )
    assert frames == expected
    assert len(pcm) == frames * config.FRAME_BYTES


def test_max_clip_caps():
    # Constant speech well past MAX_CLIP_FRAMES: emit at the cap, no trim.
    seq = [True] * (config.MAX_CLIP_FRAMES + 100)
    clips = _drive(seq)
    assert len(clips) >= 1
    _, frames = clips[0]
    assert frames == config.MAX_CLIP_FRAMES


def test_two_clips_back_to_back():
    block = (
        [True] * 10
        + [False] * config.SILENCE_FRAMES_END
    )
    clips = _drive(block + block)
    assert len(clips) == 2


def test_wrong_frame_size_raises():
    slicer = vad.VADSlicer(lambda b, n: None)
    with pytest.raises(ValueError):
        slicer.process(b"\x00" * 100)
