"""In-memory enrollment profiles and SpeechBrain ECAPA-TDNN scoring."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

import numpy as np
from dotenv import load_dotenv

MODEL_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"


@dataclass(frozen=True)
class EnrollmentInfo:
    rider_id: str
    created_at: str
    embedding_dimensions: int
    sample_count: int


@dataclass(frozen=True)
class SpeakerMatch:
    similarity: float
    status: str
    match_threshold: float
    step_up_threshold: float
    sample_scores: tuple[float, ...]


class SpeakerVerifier:
    """Extract ECAPA-TDNN embeddings and compare against every KYC clip."""

    def __init__(self) -> None:
        load_dotenv()
        # SpeechBrain's published ECAPA VoxCeleb verifier uses 0.25 as its
        # default cosine decision threshold. Both bands remain demo defaults
        # until calibrated on the actual phone and rider population.
        self.match_threshold = float(os.getenv("KYC_MATCH_THRESHOLD", "0.25"))
        self.step_up_threshold = float(os.getenv("KYC_STEP_UP_THRESHOLD", "0.15"))
        if not 0.0 <= self.step_up_threshold < self.match_threshold <= 1.0:
            raise ValueError("Require 0 <= KYC_STEP_UP_THRESHOLD < KYC_MATCH_THRESHOLD <= 1")

        self._encoder = None
        self._encoder_lock = Lock()
        self._baselines: dict[str, tuple[list[np.ndarray], str]] = {}
        self._baseline_lock = Lock()

    def embed_speech(self, speech: np.ndarray) -> np.ndarray:
        if speech.size == 0:
            raise ValueError("Cannot create a speaker embedding without speech")

        import torch

        with self._encoder_lock:
            if self._encoder is None:
                from speechbrain.inference.speaker import SpeakerRecognition
                from speechbrain.utils.fetching import LocalStrategy

                torch.set_num_threads(max(1, int(os.getenv("VOICE_MODEL_THREADS", "2"))))
                cache_path = Path(os.getenv("SPEAKER_MODEL_CACHE", "models/speechbrain-ecapa"))
                if not cache_path.is_absolute():
                    cache_path = Path(__file__).resolve().parents[2] / cache_path
                self._encoder = SpeakerRecognition.from_hparams(
                    source=os.getenv("SPEAKER_MODEL_SOURCE", MODEL_SOURCE),
                    savedir=str(cache_path),
                    local_strategy=LocalStrategy.COPY,
                    run_opts={"device": "cpu"},
                )
            waveform = torch.from_numpy(np.asarray(speech, dtype=np.float32)).unsqueeze(0)
            embedding = self._encoder.encode_batch(waveform, normalize=False)
            vector = np.asarray(embedding.squeeze().detach().cpu(), dtype=np.float32)

        if vector.ndim != 1 or vector.size < 64:
            raise RuntimeError(f"Expected a speaker embedding vector, got shape {vector.shape}")
        if not np.isfinite(vector).all():
            raise RuntimeError("Speaker encoder returned invalid values")
        norm = float(np.linalg.norm(vector))
        if norm <= 0.0:
            raise RuntimeError("Speaker encoder returned a zero vector")
        return vector / norm

    def enroll(self, rider_id: str, speech: np.ndarray, append: bool = False) -> EnrollmentInfo:
        return self.enroll_embeddings(rider_id, [self.embed_speech(speech)], append=append)

    def enroll_embeddings(
        self, rider_id: str, vectors: list[np.ndarray], append: bool = False
    ) -> EnrollmentInfo:
        """Save multiple utterance vectors as one profile update."""
        if not vectors:
            raise ValueError("At least one embedding is required")
        dimensions = vectors[0].shape
        if len(dimensions) != 1:
            raise ValueError("Enrollment vectors must be one-dimensional")
        normalized_vectors: list[np.ndarray] = []
        for vector in vectors:
            if vector.shape != dimensions or not np.isfinite(vector).all():
                raise ValueError("Enrollment contains an invalid speaker embedding")
            norm = float(np.linalg.norm(vector))
            if norm <= 0.0:
                raise ValueError("Enrollment contains a zero speaker embedding")
            normalized_vectors.append(np.asarray(vector / norm, dtype=np.float32))

        created_at = datetime.now(UTC).isoformat()
        with self._baseline_lock:
            existing = self._baselines.get(rider_id)
            previous = existing[0] if append and existing else []
            if previous and previous[0].shape != dimensions:
                raise ValueError("New enrollment embedding dimensions differ from the existing profile")
            samples = (previous + normalized_vectors)[-5:]
            self._baselines[rider_id] = (samples, created_at)
        return EnrollmentInfo(
            rider_id=rider_id,
            created_at=created_at,
            embedding_dimensions=int(dimensions[0]),
            sample_count=len(samples),
        )

    def has_enrollment(self, rider_id: str) -> bool:
        with self._baseline_lock:
            return rider_id in self._baselines

    def sample_count(self, rider_id: str) -> int:
        with self._baseline_lock:
            enrollment = self._baselines.get(rider_id)
            return len(enrollment[0]) if enrollment else 0

    def match(self, rider_id: str, speech: np.ndarray) -> SpeakerMatch | None:
        return self.match_embedding(rider_id, self.embed_speech(speech))

    def match_embedding(self, rider_id: str, vector: np.ndarray) -> SpeakerMatch | None:
        with self._baseline_lock:
            enrollment = self._baselines.get(rider_id)
            samples = [sample.copy() for sample in enrollment[0]] if enrollment else None
        if not samples:
            return None

        vector = np.asarray(vector, dtype=np.float32)
        if vector.shape != samples[0].shape or not np.isfinite(vector).all():
            raise ValueError("Call embedding is invalid or does not match the enrollment profile")
        norm = float(np.linalg.norm(vector))
        if norm <= 0.0:
            raise ValueError("Call embedding is a zero vector")
        vector = vector / norm
        scores = tuple(float(np.clip(np.dot(sample, vector), -1.0, 1.0)) for sample in samples)
        # The median makes a single unusually good/bad enrollment clip less decisive.
        similarity = float(np.median(scores))
        if similarity >= self.match_threshold:
            status = "passed"
        elif similarity >= self.step_up_threshold:
            status = "warn"
        else:
            status = "alert"
        return SpeakerMatch(
            similarity=similarity,
            status=status,
            match_threshold=self.match_threshold,
            step_up_threshold=self.step_up_threshold,
            sample_scores=scores,
        )
