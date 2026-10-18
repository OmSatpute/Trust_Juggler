"""FastAPI entry point for the voice verification service."""

from __future__ import annotations

import logging
import math
import json
import os
from dataclasses import dataclass, field
from contextlib import contextmanager
from functools import lru_cache
from threading import Lock
from typing import Iterator, Literal
from uuid import uuid4
from datetime import UTC, datetime
import sqlite3
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.app.audio_pipeline import AudioProcessingError, process_audio
from backend.app.speaker import SpeakerMatch, SpeakerVerifier
from backend.app.shift_timeline import ShiftTimeline

MAX_AUDIO_BYTES = 25 * 1024 * 1024
logger = logging.getLogger(__name__)
BATCH_SAMPLE_COUNT = 5
MIN_SPEECH_SECONDS = 2.0


@dataclass
class PendingVoiceBatch:
    rider_id: str
    samples: dict[int, np.ndarray] = field(default_factory=dict)


_batch_lock = Lock()
_pending_batches: dict[str, PendingVoiceBatch] = {}

app = FastAPI(
    title="Rider Voice Verification API",
    version="0.1.0",
    description="Offline speaker verification with five-clip enrollment and ECAPA-TDNN embeddings.",
)


@app.get("/dashboard", include_in_schema=False)
def trust_dashboard() -> FileResponse:
    return FileResponse(Path(__file__).resolve().parents[2] / "dashboard" / "index.html")


class LayerResult(BaseModel):
    status: Literal["pending", "passed", "warn", "alert", "failed"]
    reason: str


class VoiceCheckResponse(BaseModel):
    request_id: str
    verdict: Literal["pending", "verified", "step_up", "alert"]
    kyc_similarity: float | None = None
    shift_similarity: float | None = None
    sample_scores: list[float] = Field(default_factory=list)
    sample_score_spread: float | None = None
    vad_noise_reduction_pct: float | None = None
    speech_duration_seconds: float | None = None
    speaker_model: str
    layers: dict[str, LayerResult]


class EnrollmentResponse(BaseModel):
    rider_id: str
    created_at: str
    embedding_dimensions: int
    sample_count: int
    storage: Literal["in_memory"]


class EnrollmentStatusResponse(BaseModel):
    rider_id: str
    enrolled: bool
    sample_count: int


class BatchSampleResponse(BaseModel):
    status: Literal["collecting", "complete"]
    batch_id: str
    samples_received: int
    samples_required: int = BATCH_SAMPLE_COUNT
    enrollment: EnrollmentResponse | None = None


class ShiftCallResponse(BaseModel):
    call_label: str
    slot: int
    similarity: float | None
    status: str
    recorded_at: str


class ShiftTimelineResponse(BaseModel):
    rider_id: str
    shift_id: str
    baseline_set: bool
    calls: list[ShiftCallResponse]


class AccountSessionRequest(BaseModel):
    rider_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=96)
    telemetry: dict


class AccountSessionResponse(BaseModel):
    rider_id: str
    session_id: str
    baseline: bool
    status: Literal["baseline", "normal", "review", "alert"]
    risk_flags: list[str]
    changes: dict[str, bool]
    previous_session_at: str | None = None


class GestureSample(BaseModel):
    duration_ms: float = Field(gt=100, le=30000)
    curve: tuple[float, float, float, float]
    vertical_drift: float
    tilt_delta: float


class GestureBaselineRequest(BaseModel):
    samples: list[GestureSample] = Field(min_length=3, max_length=3)


class GestureCheckRequest(BaseModel):
    rider_id: str = Field(min_length=1, max_length=64)
    sample: GestureSample


class GestureCheckResponse(BaseModel):
    rider_id: str
    status: Literal["pending", "passed", "warn", "alert"]
    failed_features: list[str]
    features_within_range: int
    reason: str


class GestureProfileResponse(BaseModel):
    rider_id: str
    enrolled: bool
    sample_count: int
    updated_at: str | None = None


@lru_cache(maxsize=1)
def get_speaker_verifier() -> SpeakerVerifier:
    """Reuse one encoder and the demo's in-memory enrollment table."""
    return SpeakerVerifier()


@lru_cache(maxsize=1)
def get_shift_timeline() -> ShiftTimeline:
    shift_match_threshold = float(os.getenv("SHIFT_MATCH_THRESHOLD", "0.25"))
    shift_step_up_threshold = float(os.getenv("SHIFT_STEP_UP_THRESHOLD", "0.15"))
    return ShiftTimeline(shift_match_threshold, shift_step_up_threshold)


def aggregate_verdict(layers: dict[str, LayerResult]) -> str:
    """Derive a conservative demo verdict from completed layer statuses."""
    statuses = [layer.status for layer in layers.values()]
    if "alert" in statuses or "failed" in statuses:
        return "alert"
    if "pending" in statuses:
        return "pending"
    if "warn" in statuses:
        return "step_up"
    return "verified"


def read_audio_upload(audio: UploadFile) -> bytes:
    """Read a bounded audio upload and always close its temporary file."""
    try:
        content_type = (audio.content_type or "").lower()
        if not (content_type.startswith("audio/") or content_type == "application/octet-stream"):
            raise HTTPException(status_code=415, detail="Upload must be an audio file")
        audio_bytes = audio.file.read(MAX_AUDIO_BYTES + 1)
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Audio upload is empty")
        if len(audio_bytes) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio upload exceeds 25 MB")
        return audio_bytes
    finally:
        audio.file.close()


@app.get("/health")
def health() -> dict[str, str]:
    """Return lightweight service health without loading ML model weights."""
    return {"status": "ok", "service": "voice-verification-api"}


def _account_db_path() -> Path:
    return Path(os.getenv("ACCOUNT_SESSION_DB", "data/account_sessions.sqlite3"))


@contextmanager
def _account_db() -> Iterator[sqlite3.Connection]:
    path = _account_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.execute("""CREATE TABLE IF NOT EXISTS account_sessions (
        rider_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
        ip TEXT, device_id TEXT, lat REAL, lon REAL, simulated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (rider_id, session_id))""")
    db.execute("CREATE INDEX IF NOT EXISTS ix_account_sessions_latest ON account_sessions(rider_id, created_at)")
    db.execute("""CREATE TABLE IF NOT EXISTS account_events (
        event_id TEXT PRIMARY KEY, rider_id TEXT NOT NULL, created_at TEXT NOT NULL,
        signal TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL,
        severity INTEGER NOT NULL DEFAULT 0)""")
    db.execute("CREATE INDEX IF NOT EXISTS ix_account_events_recent ON account_events(created_at DESC)")
    db.execute("""CREATE TABLE IF NOT EXISTS gesture_profiles (
        rider_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, sample_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL)""")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.post("/api/v1/account-sessions", response_model=AccountSessionResponse)
def record_account_session(request: AccountSessionRequest) -> AccountSessionResponse:
    """Compare current login context with the account's prior stored session."""
    rider_id = request.rider_id.strip()
    session_id = request.session_id.strip()
    telemetry = request.telemetry
    if not rider_id or not session_id:
        raise HTTPException(status_code=422, detail="rider_id and session_id cannot be blank")
    if telemetry.get("simulated"):
        raise HTTPException(status_code=422, detail="Simulated telemetry cannot update an account baseline")
    now = datetime.now(UTC).isoformat()
    try:
        with _account_db() as db:
            previous = db.execute(
                "SELECT created_at, ip, device_id, lat, lon FROM account_sessions WHERE rider_id=? AND session_id<>? ORDER BY created_at DESC LIMIT 1",
                (rider_id, session_id),
            ).fetchone()
            changes = {"ip_changed": False, "device_changed": False, "location_changed": False}
            flags: list[str] = []
            client_flags = telemetry.get("risk_flags") or []
            if "IMPOSSIBLE_TRAVEL" in client_flags and not telemetry.get("simulated"):
                flags.append("IMPOSSIBLE_TRAVEL")
            if "OFF_HOURS_LOGIN" in client_flags:
                flags.append("OFF_HOURS_LOGIN")
            baseline = previous is None
            previous_at = previous[0] if previous else None
            if previous:
                prior_at, prior_ip, prior_device, prior_lat, prior_lon = previous
                current_ip = telemetry.get("ip")
                current_device = telemetry.get("device_id")
                changes["ip_changed"] = bool(prior_ip and current_ip and prior_ip != current_ip)
                changes["device_changed"] = bool(prior_device and current_device and prior_device != current_device)
                lat, lon = telemetry.get("lat"), telemetry.get("lon")
                if None not in (prior_lat, prior_lon, lat, lon):
                    dlat = math.radians(float(lat) - float(prior_lat))
                    dlon = math.radians(float(lon) - float(prior_lon))
                    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(float(prior_lat))) * math.cos(math.radians(float(lat))) * math.sin(dlon / 2) ** 2
                    distance_km = 6371 * 2 * math.asin(math.sqrt(min(1.0, a)))
                    elapsed_hours = max((datetime.fromisoformat(now) - datetime.fromisoformat(prior_at)).total_seconds() / 3600, 1 / 3600)
                    changes["location_changed"] = distance_km >= 1.0
                    if distance_km / elapsed_hours > 120:
                        flags.append("IMPOSSIBLE_TRAVEL")
                if changes["ip_changed"]:
                    flags.append("IP_CHANGED")
                if changes["device_changed"]:
                    flags.append("DEVICE_CHANGED")
                changed_count = sum((changes["ip_changed"], changes["device_changed"], changes["location_changed"]))
                if changed_count >= 2:
                    flags.append("MULTIPLE_ACCOUNT_CONTEXT_CHANGES")
            db.execute(
                "INSERT OR IGNORE INTO account_sessions(rider_id,session_id,created_at,ip,device_id,lat,lon,simulated) VALUES(?,?,?,?,?,?,?,0)",
                (rider_id, session_id, now, telemetry.get("ip"), telemetry.get("device_id"), telemetry.get("lat"), telemetry.get("lon")),
            )
        status = "baseline" if baseline else "alert" if "IMPOSSIBLE_TRAVEL" in flags else "review" if flags else "normal"
        response = AccountSessionResponse(rider_id=rider_id, session_id=session_id, baseline=baseline, status=status, risk_flags=flags or (["BASELINE_ESTABLISHED"] if baseline else []), changes=changes, previous_session_at=previous_at)
        severity = 100 if status == "alert" else 65 if status == "review" else 0
        with _account_db() as db:
            db.execute("INSERT INTO account_events VALUES(?,?,?,?,?,?,?)", (str(uuid4()), rider_id, now, "context", status, json.dumps({"risk_flags": response.risk_flags, "changes": changes}), severity))
        return response
    except (ValueError, TypeError, sqlite3.Error) as exc:
        logger.exception("Account session comparison failed")
        raise HTTPException(status_code=500, detail="Account session could not be recorded") from exc


GESTURE_FEATURE_NAMES = ("duration", "curve_25", "curve_50", "curve_75", "curve_95", "vertical_drift", "tilt_delta")
GESTURE_MARGIN_FLOORS = (350.0, 10.0, 10.0, 10.0, 10.0, 12.0, 2.0)


def gesture_values(sample: GestureSample) -> list[float]:
    return [sample.duration_ms, *sample.curve, sample.vertical_drift, sample.tilt_delta]


@app.post("/api/v1/gesture-baselines/{rider_id}", response_model=GestureProfileResponse)
def save_gesture_baseline(rider_id: str, request: GestureBaselineRequest) -> GestureProfileResponse:
    """Store three swipe feature samples as a per-rider comparison profile."""
    rider_id = rider_id.strip()
    if not rider_id:
        raise HTTPException(status_code=422, detail="rider_id cannot be blank")
    rows = [gesture_values(sample) for sample in request.samples]
    means = [sum(row[i] for row in rows) / len(rows) for i in range(len(GESTURE_FEATURE_NAMES))]
    deviations = [float(np.std([row[i] for row in rows])) for i in range(len(GESTURE_FEATURE_NAMES))]
    profile = {"features": list(GESTURE_FEATURE_NAMES), "means": means, "deviations": deviations, "margin_floors": list(GESTURE_MARGIN_FLOORS)}
    updated_at = datetime.now(UTC).isoformat()
    try:
        with _account_db() as db:
            db.execute(
                "INSERT INTO gesture_profiles(rider_id,profile_json,sample_count,updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(rider_id) DO UPDATE SET profile_json=excluded.profile_json,sample_count=excluded.sample_count,updated_at=excluded.updated_at",
                (rider_id, json.dumps(profile), len(rows), updated_at),
            )
    except sqlite3.Error as exc:
        logger.exception("Gesture baseline could not be saved")
        raise HTTPException(status_code=500, detail="Gesture baseline could not be saved") from exc
    return GestureProfileResponse(rider_id=rider_id, enrolled=True, sample_count=len(rows), updated_at=updated_at)


@app.get("/api/v1/gesture-baselines/{rider_id}", response_model=GestureProfileResponse)
def gesture_baseline_status(rider_id: str) -> GestureProfileResponse:
    with _account_db() as db:
        row = db.execute("SELECT sample_count,updated_at FROM gesture_profiles WHERE rider_id=?", (rider_id.strip(),)).fetchone()
    if not row:
        return GestureProfileResponse(rider_id=rider_id, enrolled=False, sample_count=0)
    return GestureProfileResponse(rider_id=rider_id, enrolled=True, sample_count=row[0], updated_at=row[1])


@app.post("/api/v1/gesture-checks", response_model=GestureCheckResponse)
def check_gesture(request: GestureCheckRequest) -> GestureCheckResponse:
    rider_id = request.rider_id.strip()
    with _account_db() as db:
        row = db.execute("SELECT profile_json FROM gesture_profiles WHERE rider_id=?", (rider_id,)).fetchone()
    if not row:
        return GestureCheckResponse(rider_id=rider_id, status="pending", failed_features=[], features_within_range=0, reason="Calibrate three account-holder swipes first")
    profile = json.loads(row[0])
    current = gesture_values(request.sample)
    out_of_range: list[str] = []
    for index, value in enumerate(current):
        tolerance = max(profile["margin_floors"][index], profile["deviations"][index] * 2.5)
        if abs(value - profile["means"][index]) > tolerance:
            out_of_range.append(GESTURE_FEATURE_NAMES[index])
    within = len(GESTURE_FEATURE_NAMES) - len(out_of_range)
    status = "passed" if not out_of_range else "warn" if len(out_of_range) <= 2 else "alert"
    reason = "Swipe falls within the saved account-holder pattern range" if not out_of_range else f"{len(out_of_range)} gesture features differ from the saved range; review with other account signals"
    response = GestureCheckResponse(rider_id=rider_id, status=status, failed_features=out_of_range, features_within_range=within, reason=reason)
    severity = 100 if status == "alert" else 65 if status == "warn" else 0
    with _account_db() as db:
        db.execute("INSERT INTO account_events VALUES(?,?,?,?,?,?,?)", (str(uuid4()), rider_id, datetime.now(UTC).isoformat(), "swipe", status, json.dumps({"failed_features": out_of_range, "reason": reason}), severity))
    return response


class DashboardEvent(BaseModel):
    event_id: str
    rider_id: str
    created_at: str
    signal: str
    status: str
    detail: dict
    severity: int


class DashboardSummary(BaseModel):
    total_checks: int
    alerts: int
    needs_review: int
    riders_with_concerns: int
    signal_counts: dict[str, int]
    events: list[DashboardEvent]


@app.get("/api/v1/dashboard", response_model=DashboardSummary)
def dashboard_summary(limit: int = 100) -> DashboardSummary:
    """Return recent account-integrity checks for the trust operations view."""
    limit = max(1, min(limit, 500))
    with _account_db() as db:
        rows = db.execute("SELECT event_id,rider_id,created_at,signal,status,detail,severity FROM account_events ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        counts = db.execute("SELECT COUNT(*),SUM(status='alert'),SUM(status IN ('review','warn','step_up')) FROM account_events").fetchone()
        riders = db.execute("SELECT COUNT(DISTINCT rider_id) FROM account_events WHERE status IN ('alert','review','warn','step_up')").fetchone()[0]
        signal_rows = db.execute("SELECT signal,COUNT(*) FROM account_events WHERE status IN ('alert','review','warn','step_up') GROUP BY signal").fetchall()
    events = [DashboardEvent(event_id=row[0], rider_id=row[1], created_at=row[2], signal=row[3], status=row[4], detail=json.loads(row[5]), severity=row[6]) for row in rows]
    signal_counts = {signal: count for signal, count in signal_rows}
    for signal in ("context", "swipe", "voice"):
        signal_counts.setdefault(signal, 0)
    return DashboardSummary(total_checks=counts[0] or 0, alerts=counts[1] or 0, needs_review=counts[2] or 0, riders_with_concerns=riders, signal_counts=signal_counts, events=events)


@app.post("/api/v1/enrollments", response_model=EnrollmentResponse)
def enroll_rider(
    audio: UploadFile = File(...),
    rider_id: str = Form(..., min_length=1, max_length=64),
    append: bool = Form(False),
) -> EnrollmentResponse:
    """Create or replace a rider's KYC voice baseline from a speech sample."""
    rider_id = rider_id.strip()
    if not rider_id:
        raise HTTPException(status_code=422, detail="rider_id cannot be blank")
    audio_bytes = read_audio_upload(audio)
    try:
        processed = process_audio(audio_bytes)
    except AudioProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not processed.samples.size:
        raise HTTPException(status_code=422, detail="Enrollment sample contains no detectable speech")
    if processed.speech_duration_seconds < MIN_SPEECH_SECONDS:
        raise HTTPException(status_code=422, detail=f"Enrollment needs at least {MIN_SPEECH_SECONDS:.0f} seconds of detected speech")

    try:
        enrollment = get_speaker_verifier().enroll(rider_id, processed.samples, append=append)
    except Exception as exc:
        logger.exception("Speaker enrollment failed")
        raise HTTPException(status_code=503, detail="Speaker enrollment is unavailable") from exc
    return EnrollmentResponse(
        rider_id=enrollment.rider_id,
        created_at=enrollment.created_at,
        embedding_dimensions=enrollment.embedding_dimensions,
        sample_count=enrollment.sample_count,
        storage="in_memory",
    )


@app.get("/api/v1/enrollments/{rider_id}", response_model=EnrollmentStatusResponse)
def enrollment_status(rider_id: str) -> EnrollmentStatusResponse:
    rider_id = rider_id.strip()
    return EnrollmentStatusResponse(
        rider_id=rider_id,
        enrolled=get_speaker_verifier().has_enrollment(rider_id),
        sample_count=get_speaker_verifier().sample_count(rider_id),
    )


@app.get("/api/v1/shifts/{rider_id}/{shift_id}", response_model=ShiftTimelineResponse)
def shift_timeline_status(rider_id: str, shift_id: str) -> ShiftTimelineResponse:
    baseline_set, calls = get_shift_timeline().timeline(rider_id.strip(), shift_id.strip())
    return ShiftTimelineResponse(
        rider_id=rider_id,
        shift_id=shift_id,
        baseline_set=baseline_set,
        calls=[
            ShiftCallResponse(
                call_label=call.call_label,
                slot=call.slot,
                similarity=call.similarity,
                status=call.status,
                recorded_at=call.recorded_at,
            )
            for call in calls
        ],
    )


@app.post("/api/v1/voice-check", response_model=VoiceCheckResponse)
def voice_check(
    audio: UploadFile = File(...),
    rider_id: str = Form(..., min_length=1, max_length=64),
    call_label: str = Form(..., min_length=1, max_length=64),
    shift_id: str = Form(..., min_length=1, max_length=64),
) -> VoiceCheckResponse:
    """Verify a fresh Call Customer clip against the enrolled ECAPA profile."""
    rider_id = rider_id.strip()
    if not rider_id:
        raise HTTPException(status_code=422, detail="rider_id cannot be blank")
    audio_bytes = read_audio_upload(audio)

    try:
        processed = process_audio(audio_bytes)
    except AudioProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if processed.speech_duration_seconds < MIN_SPEECH_SECONDS:
        raise HTTPException(
            status_code=422,
            detail=f"Need at least {MIN_SPEECH_SECONDS:.0f} seconds of clear speech; please record again",
        )

    try:
        speaker_verifier = get_speaker_verifier()
        call_embedding = speaker_verifier.embed_speech(processed.samples)
        speaker_match: SpeakerMatch | None = speaker_verifier.match_embedding(rider_id, call_embedding)
        shift_evaluation = get_shift_timeline().record(
            rider_id=rider_id,
            shift_id=shift_id.strip(),
            call_label=call_label.strip(),
            embedding=call_embedding,
        )
    except Exception as exc:
        logger.exception("Call speaker verification failed")
        raise HTTPException(status_code=503, detail="Speaker comparison is unavailable") from exc

    layers = {
        "audio_quality": LayerResult(
            status="passed",
            reason=(
                f"{processed.speech_duration_seconds:.1f}s of voice activity retained at 16 kHz; "
                "natural speech bandwidth preserved for the speaker model"
            ),
        ),
        "kyc_speaker_match": (
            LayerResult(
                status=speaker_match.status,
                reason=(
                    f"Cosine similarity {speaker_match.similarity:.3f}; provisional pass >= "
                    f"{speaker_match.match_threshold:.2f}, step-up >= "
                    f"{speaker_match.step_up_threshold:.2f}"
                ),
            )
            if speaker_match
            else LayerResult(status="pending", reason="No KYC baseline for this rider; enroll before voice verification")
        ),
        "shift_consistency": LayerResult(status=shift_evaluation.status, reason=shift_evaluation.reason),
    }
    response = VoiceCheckResponse(
        request_id=str(uuid4()),
        verdict=aggregate_verdict(layers),
        kyc_similarity=speaker_match.similarity if speaker_match else None,
        shift_similarity=shift_evaluation.similarity,
        sample_scores=list(speaker_match.sample_scores) if speaker_match else [],
        sample_score_spread=(max(speaker_match.sample_scores) - min(speaker_match.sample_scores)) if speaker_match else None,
        vad_noise_reduction_pct=processed.vad_noise_reduction_pct,
        speech_duration_seconds=processed.speech_duration_seconds,
        speaker_model=os.getenv("SPEAKER_MODEL_SOURCE", "speechbrain/spkrec-ecapa-voxceleb"),
        layers=layers,
    )
    status = response.verdict
    severity = 100 if status == "alert" else 65 if status == "step_up" else 0
    detail = {"kyc_similarity": response.kyc_similarity, "layers": {name: layer.model_dump() for name, layer in layers.items()}}
    with _account_db() as db:
        db.execute("INSERT INTO account_events VALUES(?,?,?,?,?,?,?)", (response.request_id, rider_id, datetime.now(UTC).isoformat(), "voice", status, json.dumps(detail), severity))
    return response


@app.post("/api/v1/enrollments/batch-samples", response_model=BatchSampleResponse)
def batch_enrollment_sample(
    audio: UploadFile = File(...),
    rider_id: str = Form(..., min_length=1, max_length=64),
    batch_id: str = Form(..., min_length=1, max_length=96),
    sample_index: int = Form(..., ge=0, lt=BATCH_SAMPLE_COUNT),
) -> BatchSampleResponse:
    """Collect five separate clips and save their embeddings as one KYC baseline."""
    rider_id = rider_id.strip()
    batch_id = batch_id.strip()
    if not rider_id or not batch_id:
        raise HTTPException(status_code=422, detail="rider_id and batch_id cannot be blank")
    audio_bytes = read_audio_upload(audio)
    try:
        processed = process_audio(audio_bytes)
    except AudioProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not processed.samples.size:
        raise HTTPException(status_code=422, detail="Sample contains no detectable speech; record that sample again")
    if processed.speech_duration_seconds < MIN_SPEECH_SECONDS:
        raise HTTPException(status_code=422, detail=f"Sample needs at least {MIN_SPEECH_SECONDS:.0f} seconds of detected speech; record it again")

    try:
        embedding = get_speaker_verifier().embed_speech(processed.samples)
    except Exception as exc:
        logger.exception("Batch speaker embedding failed")
        raise HTTPException(status_code=503, detail="Speaker comparison is unavailable") from exc

    with _batch_lock:
        batch = _pending_batches.get(batch_id)
        if batch is None:
            batch = PendingVoiceBatch(rider_id=rider_id)
            _pending_batches[batch_id] = batch
        if batch.rider_id != rider_id:
            raise HTTPException(status_code=409, detail="batch_id is already associated with another rider")
        if sample_index in batch.samples:
            raise HTTPException(status_code=409, detail="This sample number was already received")
        batch.samples[sample_index] = embedding
        received = len(batch.samples)
        if received < BATCH_SAMPLE_COUNT:
            return BatchSampleResponse(status="collecting", batch_id=batch_id, samples_received=received)
        embeddings = [batch.samples[index] for index in range(BATCH_SAMPLE_COUNT)]
        del _pending_batches[batch_id]
    return BatchSampleResponse(
        status="complete",
        batch_id=batch_id,
        samples_received=BATCH_SAMPLE_COUNT,
        enrollment=speaker_verifier_enroll_batch(rider_id, embeddings),
    )


def speaker_verifier_enroll_batch(rider_id: str, embeddings: list[np.ndarray]) -> EnrollmentResponse:
    try:
        enrollment = get_speaker_verifier().enroll_embeddings(rider_id, embeddings)
    except Exception as exc:
        logger.exception("Five-sample speaker enrollment failed")
        raise HTTPException(status_code=503, detail="Speaker enrollment is unavailable") from exc
    return EnrollmentResponse(
        rider_id=enrollment.rider_id,
        created_at=enrollment.created_at,
        embedding_dimensions=enrollment.embedding_dimensions,
        sample_count=enrollment.sample_count,
        storage="in_memory",
    )
