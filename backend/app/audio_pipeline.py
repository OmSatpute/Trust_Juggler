"""Container decoding and Layer 1 cleanup for uploaded audio."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

import av
import numpy as np

SAMPLE_RATE = 16_000
MIN_AUDIO_SECONDS = 0.25
VAD_FRAME_MS = 30
VAD_PADDING_FRAMES = 3


class AudioProcessingError(ValueError):
    """Raised when the uploaded audio cannot be decoded or processed."""


@dataclass(frozen=True)
class ProcessedAudio:
    samples: np.ndarray
    sample_rate: int
    input_duration_seconds: float
    speech_duration_seconds: float
    vad_noise_reduction_pct: float


def _decode_mono_16khz(audio_bytes: bytes) -> np.ndarray:
    """Decode supported containers (including Expo M4A and WebM) via PyAV."""
    try:
        with av.open(BytesIO(audio_bytes), mode="r") as container:
            if not container.streams.audio:
                raise AudioProcessingError("Upload contains no audio stream")

            resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
            frames = []
            for frame in container.decode(container.streams.audio[0]):
                frames.extend(resampler.resample(frame))
            frames.extend(resampler.resample(None))
            if not frames:
                raise AudioProcessingError("Audio stream contains no decodable samples")
            samples = np.concatenate([frame.to_ndarray().reshape(-1) for frame in frames])
    except AudioProcessingError:
        raise
    except Exception as exc:
        raise AudioProcessingError("Unsupported or corrupt audio file") from exc

    if samples.size < int(SAMPLE_RATE * MIN_AUDIO_SECONDS):
        raise AudioProcessingError("Audio must be at least 250 ms long")
    if not np.isfinite(samples).all():
        raise AudioProcessingError("Audio contains invalid sample values")
    return samples.astype(np.float32, copy=False)


def process_audio(audio_bytes: bytes) -> ProcessedAudio:
    """Decode, retain natural voice bandwidth, and trim edges with WebRTC VAD.

    The returned VAD reduction is the percentage of decoded duration removed
    by silence trimming. It is a telemetry measure, not a security score.
    """
    if not audio_bytes:
        raise AudioProcessingError("Audio upload is empty")

    samples = _decode_mono_16khz(audio_bytes)
    input_duration = samples.size / SAMPLE_RATE

    import webrtcvad

    frame_samples = SAMPLE_RATE * VAD_FRAME_MS // 1000
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
    frame_count = len(pcm) // frame_samples
    vad = webrtcvad.Vad(2)
    voiced = [
        vad.is_speech(pcm[index * frame_samples:(index + 1) * frame_samples].tobytes(), SAMPLE_RATE)
        for index in range(frame_count)
    ]
    active = np.zeros(frame_count, dtype=bool)
    for index, is_voiced in enumerate(voiced):
        if is_voiced:
            start = max(0, index - VAD_PADDING_FRAMES)
            end = min(frame_count, index + VAD_PADDING_FRAMES + 1)
            active[start:end] = True
    if active.any():
        speech = np.concatenate([
            pcm[index * frame_samples:(index + 1) * frame_samples]
            for index, is_active in enumerate(active) if is_active
        ]).astype(np.float32) / 32768.0
    else:
        speech = np.empty(0, dtype=np.float32)
    speech_duration = speech.size / SAMPLE_RATE
    reduction_pct = 100.0 * (1.0 - min(speech.size, samples.size) / samples.size)

    return ProcessedAudio(
        samples=speech.astype(np.float32, copy=False),
        sample_rate=SAMPLE_RATE,
        input_duration_seconds=input_duration,
        speech_duration_seconds=speech_duration,
        vad_noise_reduction_pct=float(np.clip(reduction_pct, 0.0, 100.0)),
    )
