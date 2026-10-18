"""In-memory per-rider, per-shift comparison against Call #1."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from threading import Lock

import numpy as np

CALL_SLOT_PATTERN = re.compile(r"\bcall\s*#?\s*([1-4])\b", re.IGNORECASE)


@dataclass
class ShiftCall:
    call_label: str
    slot: int
    embedding: np.ndarray = field(repr=False)
    recorded_at: str
    similarity: float | None = None
    status: str = "pending"


@dataclass
class ShiftRecord:
    baseline_embedding: np.ndarray | None = field(default=None, repr=False)
    calls: list[ShiftCall] = field(default_factory=list)


@dataclass(frozen=True)
class ShiftEvaluation:
    similarity: float | None
    status: str
    reason: str


class ShiftTimeline:
    """Track calls without exposing or persisting the underlying embeddings."""

    def __init__(self, match_threshold: float, step_up_threshold: float) -> None:
        if not 0.0 <= step_up_threshold < match_threshold <= 1.0:
            raise ValueError("Require 0 <= SHIFT_STEP_UP_THRESHOLD < SHIFT_MATCH_THRESHOLD <= 1")
        self.match_threshold = match_threshold
        self.step_up_threshold = step_up_threshold
        self._records: dict[tuple[str, str], ShiftRecord] = {}
        self._lock = Lock()

    def record(
        self,
        rider_id: str,
        shift_id: str,
        call_label: str,
        embedding: np.ndarray,
    ) -> ShiftEvaluation:
        slot_match = CALL_SLOT_PATTERN.search(call_label)
        if not slot_match:
            return ShiftEvaluation(
                similarity=None,
                status="pending",
                reason="call_label must identify Call #1, #2, #3, or #4",
            )
        slot = int(slot_match.group(1))
        normalized = np.asarray(embedding, dtype=np.float32)
        norm = float(np.linalg.norm(normalized))
        if normalized.ndim != 1 or not np.isfinite(normalized).all() or norm <= 0.0:
            raise ValueError("Shift timeline requires a finite, one-dimensional speaker embedding")
        normalized = normalized / norm
        timestamp = datetime.now(UTC).isoformat()
        key = (rider_id, shift_id)

        with self._lock:
            record = self._records.setdefault(key, ShiftRecord())
            if record.baseline_embedding is not None and record.baseline_embedding.shape != normalized.shape:
                raise ValueError("Shift embedding dimensions differ from the existing shift baseline")
            if slot == 1 and record.baseline_embedding is None:
                record.baseline_embedding = normalized.copy()
                # If a later slot arrived first, now resolve its pending timeline
                # entries against the newly established Call #1 baseline.
                for previous_call in record.calls:
                    self._score_call(previous_call, record.baseline_embedding)

            call = ShiftCall(
                call_label=call_label,
                slot=slot,
                embedding=normalized.copy(),
                recorded_at=timestamp,
            )
            if record.baseline_embedding is not None:
                self._score_call(call, record.baseline_embedding)
            record.calls.append(call)

            if record.baseline_embedding is None:
                return ShiftEvaluation(
                    similarity=None,
                    status="pending",
                    reason="Submit Call #1 first to establish the shift baseline",
                )
            if slot == 1 and len(record.calls) == 1:
                return ShiftEvaluation(
                    similarity=1.0,
                    status="passed",
                    reason="Call #1 established the shift-start baseline",
                )
            return ShiftEvaluation(
                similarity=call.similarity,
                status=call.status,
                reason=self._reason(call.similarity),
            )

    def timeline(self, rider_id: str, shift_id: str) -> tuple[bool, list[ShiftCall]]:
        with self._lock:
            record = self._records.get((rider_id, shift_id))
            if record is None:
                return False, []
            # Return detached call objects so callers cannot mutate shared state.
            calls = [
                ShiftCall(
                    call_label=call.call_label,
                    slot=call.slot,
                    embedding=call.embedding.copy(),
                    recorded_at=call.recorded_at,
                    similarity=call.similarity,
                    status=call.status,
                )
                for call in record.calls
            ]
            return record.baseline_embedding is not None, calls

    def _score_call(self, call: ShiftCall, baseline: np.ndarray) -> None:
        call.similarity = float(np.clip(np.dot(baseline, call.embedding), -1.0, 1.0))
        call.status = self._status(call.similarity)

    def _status(self, similarity: float) -> str:
        if similarity >= self.match_threshold:
            return "passed"
        if similarity >= self.step_up_threshold:
            return "warn"
        return "alert"

    def _reason(self, similarity: float | None) -> str:
        if similarity is None:
            return "No Call #1 baseline is available"
        return (
            f"Cosine similarity to Call #1 is {similarity:.3f}; provisional pass >= "
            f"{self.match_threshold:.2f}, step-up >= {self.step_up_threshold:.2f}"
        )
