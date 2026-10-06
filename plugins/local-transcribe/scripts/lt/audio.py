"""Reading the extracted WAV into the float32 array every engine accepts.

Both Whisper implementations take either a path or an array, and taking the
path is a trap: `mlx_whisper` loads a path by shelling out to a bare `ffmpeg`
on PATH, which defeats the whole point of taking `ffmpeg` from a wheel — the
wheel's binary is named `ffmpeg-macos-aarch64-v7.1`, so nothing named `ffmpeg`
is ever found and the run dies with FileNotFoundError after the model has
already loaded. Handing over an array removes that subprocess entirely.

The pipeline has already normalised the audio to 16 kHz mono PCM by this point,
so this is a stdlib `wave` read and a divide.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000


def read_wav_f32(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise ValueError(
                f"expected 16-bit PCM, got {handle.getsampwidth() * 8}-bit — "
                "the extraction step should have produced pcm_s16le"
            )
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples
