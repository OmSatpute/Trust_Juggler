"""FastAPI entry point for the voice verification service."""

from __future__ import annotations

import logging
import os
import copy
import json
from dataclasses import dataclass, field
from datetime import datetime, UTC
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Any, Literal
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
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
    has_previous_baseline: bool = False
    previous_created_at: str | None = None
    similarity_with_previous: float | None = None
    re_enrollment_verdict: str | None = None
    storage: Literal["persistent_npz", "in_memory"] = "persistent_npz"


class EnrollmentStatusResponse(BaseModel):
    rider_id: str
    enrolled: bool
    sample_count: int
    created_at: str | None = None
    has_previous_baseline: bool = False
    previous_created_at: str | None = None
    similarity_with_previous: float | None = None
    re_enrollment_verdict: str | None = None


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
    details = get_speaker_verifier().get_enrollment_details(rider_id)
    return EnrollmentStatusResponse(
        rider_id=rider_id,
        enrolled=bool(details["enrolled"]),
        sample_count=int(details["sample_count"]),
        created_at=str(details["created_at"]) if details["created_at"] else None,
        has_previous_baseline=bool(details["has_previous_baseline"]),
        previous_created_at=str(details["previous_created_at"]) if details["previous_created_at"] else None,
        similarity_with_previous=float(details["similarity_with_previous"]) if details["similarity_with_previous"] is not None else None,
        re_enrollment_verdict=str(details["re_enrollment_verdict"]) if details["re_enrollment_verdict"] else None,
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
    v = aggregate_verdict(layers)
    status_map = {"verified": "verified", "step_up": "warn", "alert": "alert", "pending": "pending"}
    sev_map = {"verified": 0, "step_up": 65, "alert": 100, "pending": 25}
    record_dashboard_event(
        rider_id=rider_id,
        signal="voice",
        status=status_map.get(v, "review"),
        severity=sev_map.get(v, 65),
        detail={
            "kyc_similarity": speaker_match.similarity if speaker_match else None,
            "layers": {k: {"status": l.status, "reason": l.reason} for k, l in layers.items()},
        },
    )
    return VoiceCheckResponse(
        request_id=str(uuid4()),
        verdict=v,
        kyc_similarity=speaker_match.similarity if speaker_match else None,
        shift_similarity=shift_evaluation.similarity,
        sample_scores=list(speaker_match.sample_scores) if speaker_match else [],
        sample_score_spread=(max(speaker_match.sample_scores) - min(speaker_match.sample_scores)) if speaker_match else None,
        vad_noise_reduction_pct=processed.vad_noise_reduction_pct,
        speech_duration_seconds=processed.speech_duration_seconds,
        speaker_model=os.getenv("SPEAKER_MODEL_SOURCE", "speechbrain/spkrec-ecapa-voxceleb"),
        layers=layers,
    )


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
        has_previous_baseline=enrollment.has_previous_baseline,
        previous_created_at=enrollment.previous_created_at,
        similarity_with_previous=enrollment.similarity_with_previous,
        re_enrollment_verdict=enrollment.re_enrollment_verdict,
        storage="persistent_npz",
    )


# ---------------------------------------------------------------------------
# Trust Control Tower Dashboard WebSocket & Telemetry Alert Emitter
# ---------------------------------------------------------------------------
_active_websockets: set[WebSocket] = set()

DEFAULT_TOWER_STATE: dict[str, Any] = {
    "overall_trust_score": 96.8,
    "monthly_strikes": 0,
    "isLocked": False,
    "weightOverrideActive": False,
    "rider": {
        "riderId": "#RIDER-MUM-402",
        "name": "Arjun R. Sharma",
        "city": "Mumbai, MH",
        "hub": "Bandra-Kurla Complex Hub 04",
        "vehicle": "Ather 450X (EV) · MH-02-EE-8821",
        "shiftHours": "06h 42m Active",
        "activeOrdersToday": 14,
        "lifetimeDeliveries": 3840,
        "trustTier": "Standard",
        "joinedDate": "March 2024",
        "batteryLevel": 78,
    },
    "alertBanner": {
        "active": True,
        "title": "STATUS: AUTHENTICATED & OPTIMAL",
        "message": "Continuous multi-modal verification running. All 5 security axes exceed 95% trust baseline.",
        "level": "info",
    },
    "spiderweb_radar": [
        {
            "axis": "Restaurant Face",
            "name": "Restaurant Face",
            "value": 98,
            "weight": 0.25,
            "threshold": 80,
            "status": "optimal",
            "description": "Liveness mesh 3D landmark depth confirmed at merchant kiosk",
        },
        {
            "axis": "Voice ECAPA",
            "name": "Voice ECAPA",
            "value": 96,
            "weight": 0.25,
            "threshold": 75,
            "status": "optimal",
            "description": "ECAPA-TDNN neural voiceprint matching rider acoustic baseline",
        },
        {
            "axis": "GPS Spatial",
            "name": "GPS Spatial",
            "value": 95,
            "weight": 0.20,
            "threshold": 70,
            "status": "optimal",
            "description": "Real-time velocity vector consistent with road corridor (No Mock GPS)",
        },
        {
            "axis": "Device/IP DNA",
            "name": "Device/IP DNA",
            "value": 97,
            "weight": 0.15,
            "threshold": 65,
            "status": "optimal",
            "description": "Hardware IMEI, carrier ASN & TLS client fingerprint verified",
        },
        {
            "axis": "Kinetic Slider",
            "name": "Kinetic Slider",
            "value": 97,
            "weight": 0.15,
            "threshold": 70,
            "status": "optimal",
            "description": "Neuromuscular touch dynamics & swipe curvature match historical profile",
        },
    ],
    "telemetry": {
        "faceMatch": {
            "percentage": 98.4,
            "livenessScore": 0.99,
            "matchConfidence": "Ultra High (ArcFace v4)",
            "verifiedAt": "Just now (Merchant Terminal)",
            "cameraMeshPoints": 468,
            "status": "optimal",
        },
        "voiceSimilarity": {
            "similarityPercent": 96.2,
            "model": "ECAPA-TDNN (D-Vector)",
            "dVectorDistance": 0.084,
            "ambientNoiseDb": 54,
            "status": "optimal",
        },
        "sliderEnvelope": {
            "envelopePercent": 97.6,
            "swipeDurationMs": 418,
            "pressureDeviation": 0.04,
            "kineticProfile": "Natural Human Tremor (Valid)",
            "status": "optimal",
        },
        "gpsSpeed": {
            "speedKmh": 24.5,
            "speedVariance": 1.2,
            "mockLocationDetected": False,
            "spatialDriftMeters": 2.1,
            "teleportFlag": False,
            "status": "optimal",
        },
    },
    "incidentHistory": [
        {
            "id": "INC-902",
            "timestamp": "Today, 08:14 AM",
            "type": "Shift Start Verification",
            "severity": "low",
            "detail": "Biometric face match verified on merchant arrival at BKC Kiosk #2",
        }
    ],
}

_current_state: dict[str, Any] = copy.deepcopy(DEFAULT_TOWER_STATE)


async def broadcast_tower_state(state: dict[str, Any]) -> None:
    """Broadcast state to all connected dashboard WebSocket clients."""
    disconnected = set()
    for ws in list(_active_websockets):
        try:
            await ws.send_json(state)
        except Exception:
            disconnected.add(ws)
    _active_websockets.difference_update(disconnected)


@app.websocket("/ws/telemetry")
async def websocket_telemetry(websocket: WebSocket) -> None:
    await websocket.accept()
    _active_websockets.add(websocket)
    try:
        await websocket.send_json(_current_state)
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        _active_websockets.discard(websocket)


@app.get("/api/telemetry/state")
def get_telemetry_state() -> dict[str, Any]:
    return _current_state


@app.post("/api/alert")
async def trigger_dashboard_alert(request: Request) -> dict[str, Any]:
    """Trigger an explicit alert banner and radar change on the dashboard."""
    body = await request.json()
    title = str(body.get("title", "SECURITY ALERT"))
    message = str(body.get("message", "Anomalous activity detected."))
    level = str(body.get("level", "danger"))
    event_type = str(body.get("event_type", "GENERIC_ALERT"))

    _current_state["alertBanner"] = {
        "active": True,
        "title": title,
        "message": message,
        "level": level,
    }

    incident_id = f"INC-{int(datetime.now(UTC).timestamp()) % 10000}"
    _current_state["incidentHistory"].insert(0, {
        "id": incident_id,
        "timestamp": "Just now",
        "type": event_type,
        "severity": "critical" if level == "danger" else "medium",
        "detail": message,
    })

    await broadcast_tower_state(_current_state)
    return {"status": "ok", "broadcasted": True, "active_clients": len(_active_websockets)}


@app.post("/api/telemetry")
async def receive_telemetry(request: Request) -> dict[str, Any]:
    """Accept mobile telemetry, detect anomalies, update state, and broadcast to Dashboard."""
    body = {}
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            body = await request.json()
        except Exception:
            body = {}
    elif "multipart/form-data" in content_type:
        form = await request.form()
        payload_str = form.get("payload")
        if payload_str and isinstance(payload_str, str):
            try:
                body = json.loads(payload_str)
            except Exception:
                body = {}

    trigger = str(body.get("trigger_event", body.get("event_type", "")))
    stage1 = body.get("stage_1_network_gps", {})
    slider = body.get("stage_3_slider", {})

    is_mock = bool(stage1.get("is_impossible_travel") or stage1.get("mock_location_detected") or trigger == "MOCK_LOCATION")
    device_id = str(stage1.get("device_id", ""))
    is_device_changed = bool("SPOOF" in device_id or "EMULATOR" in device_id or trigger == "DEVICE_ID_CHANGE")
    is_slider_failed = bool(slider.get("is_rejected") or trigger == "SLIDER_BIOMETRIC_FAIL")

    timestamp_str = datetime.now(UTC).strftime("%H:%M:%S UTC")

    # 1. Location anomaly / Mock Location
    if is_mock or trigger in ("MOCK_LOCATION", "SUDDEN_LOCATION_CHANGE"):
        speed_kmh = float(stage1.get("velocity_kmh", 850.0))
        dist_km = float(stage1.get("distance_km", 45.2))
        _current_state["telemetry"]["gpsSpeed"]["mockLocationDetected"] = True
        _current_state["telemetry"]["gpsSpeed"]["teleportFlag"] = True
        _current_state["telemetry"]["gpsSpeed"]["speedKmh"] = speed_kmh
        _current_state["telemetry"]["gpsSpeed"]["status"] = "breach"
        _current_state["overall_trust_score"] = max(18.0, _current_state["overall_trust_score"] - 35.0)
        _current_state["monthly_strikes"] = min(3, _current_state["monthly_strikes"] + 1)
        if _current_state["monthly_strikes"] >= 3:
            _current_state["isLocked"] = True

        for axis in _current_state["spiderweb_radar"]:
            if axis["axis"] == "GPS Spatial":
                axis["value"] = 25
                axis["status"] = "breach"
                axis["description"] = f"SPATIAL TELEPORT: Sudden leap of {dist_km:.1f} km at {speed_kmh:.1f} km/h (Mock Location)"

        _current_state["alertBanner"] = {
            "active": True,
            "title": "🚨 CRITICAL SPATIAL BREACH — SUDDEN LOCATION JUMP DETECTED",
            "message": f"Rider leaped {dist_km:.1f} km instantly at {speed_kmh:.1f} km/h. Mock GPS provider or device teleportation active.",
            "level": "danger",
        }
        record_dashboard_event(
            rider_id=rider_id,
            signal="context",
            status="alert",
            severity=100,
            detail={
                "changes": {"location_changed": True, "device_id_changed": False},
                "risk_flags": ["IMPOSSIBLE_TRAVEL (850 km/h)", "MOCK_LOCATION_DETECTED"],
            },
        )

    # 2. Hardware / Device ID mismatch
    elif is_device_changed or trigger == "DEVICE_ID_CHANGE":
        _current_state["weightOverrideActive"] = True
        _current_state["overall_trust_score"] = 89.2
        for axis in _current_state["spiderweb_radar"]:
            if axis["axis"] == "Device/IP DNA":
                axis["value"] = 20
                axis["weight"] = 0.0
                axis["status"] = "attenuated"
                axis["description"] = f"DEVICE MISMATCH: Unknown hardware fingerprint ({device_id[:24]}). Weight attenuated to 0%."

        _current_state["alertBanner"] = {
            "active": True,
            "title": "⚠️ DEVICE ANOMALY DETECTED — HARDWARE DNA MISMATCH",
            "message": f"Unrecognized Device ID ({device_id[:32]}). Device DNA weight attenuated from 15% -> 0%.",
            "level": "warning",
        }
        _current_state["incidentHistory"].insert(0, {
            "id": f"INC-{int(datetime.now(UTC).timestamp()) % 10000}",
            "timestamp": timestamp_str,
            "type": "Device DNA Mismatch",
            "severity": "medium",
            "detail": f"Hardware fingerprint changed to {device_id[:28]}. Weight rebalanced.",
        })
        record_dashboard_event(
            rider_id=rider_id,
            signal="context",
            status="alert",
            severity=100,
            detail={
                "changes": {"location_changed": False, "device_id_changed": True},
                "risk_flags": ["DEVICE_FINGERPRINT_MISMATCH", f"ID: {device_id[:24]}"],
            },
        )

    # 3. Slider Biometric Rejection
    elif is_slider_failed:
        _current_state["telemetry"]["sliderEnvelope"]["status"] = "breach"
        _current_state["telemetry"]["sliderEnvelope"]["envelopePercent"] = 28.0
        for axis in _current_state["spiderweb_radar"]:
            if axis["axis"] == "Kinetic Slider":
                axis["value"] = 28
                axis["status"] = "breach"
                axis["description"] = "CRITICAL: Slider curvature & touch velocity deviated from biological baseline."

        _current_state["alertBanner"] = {
            "active": True,
            "title": "⚠️ KINETIC SLIDER ANOMALY — STRIKE WARNING",
            "message": "Slider touch dynamics deviated from biological envelope. Robotic swipe or impostor detected.",
            "level": "warning",
        }
        _current_state["incidentHistory"].insert(0, {
            "id": f"INC-{int(datetime.now(UTC).timestamp()) % 10000}",
            "timestamp": timestamp_str,
            "type": "Kinetic Slider Mismatch",
            "severity": "high",
            "detail": "Slider verification failed against rider envelope.",
        })
        record_dashboard_event(
            rider_id=rider_id,
            signal="swipe",
            status="alert",
            severity=100,
            detail={
                "failed_features": slider.get("failed_metrics", ["pitch_push", "velocity_symmetry"]),
                "reason": "Swipe velocity/curve deviated from biological baseline envelope",
            },
        )

    # 4. Normal / Genuine reset
    elif trigger in ("SET_CURRENT_LOCATION", "RESTORE_GENUINE", "SLIDER_BIOMETRIC_PASS"):
        _current_state["alertBanner"] = {
            "active": True,
            "title": "STATUS: AUTHENTICATED & OPTIMAL",
            "message": "Continuous multi-modal verification running. All 5 security axes exceed 95% trust baseline.",
            "level": "info",
        }
        _current_state["telemetry"]["gpsSpeed"]["mockLocationDetected"] = False
        _current_state["telemetry"]["gpsSpeed"]["teleportFlag"] = False
        _current_state["telemetry"]["gpsSpeed"]["speedKmh"] = 24.5
        _current_state["telemetry"]["gpsSpeed"]["status"] = "optimal"
        for axis in _current_state["spiderweb_radar"]:
            axis["status"] = "optimal"
            axis["value"] = 96

        if trigger == "SLIDER_BIOMETRIC_PASS":
            record_dashboard_event(
                rider_id=rider_id,
                signal="swipe",
                status="verified",
                severity=0,
                detail={
                    "failed_features": [],
                    "reason": "Swipe features within biological envelope (98% confidence)",
                },
            )
        elif trigger == "SET_CURRENT_LOCATION":
            record_dashboard_event(
                rider_id=rider_id,
                signal="context",
                status="normal",
                severity=0,
                detail={
                    "changes": {"location_changed": False, "device_id_changed": False},
                    "risk_flags": [],
                },
            )

    elif trigger == "SLIDER_CALIBRATION":
        record_dashboard_event(
            rider_id=rider_id,
            signal="swipe",
            status="baseline",
            severity=0,
            detail={
                "failed_features": [],
                "reason": "Personalized 3-swipe baseline enrolled on device",
            },
        )

    await broadcast_tower_state(_current_state)
    return {
        "status": "ok",
        "trigger": trigger,
        "is_mock": is_mock,
        "is_device_changed": is_device_changed,
        "active_ws_clients": len(_active_websockets),
        "overall_trust_score": _current_state["overall_trust_score"],
        "strikes": _current_state["monthly_strikes"],
    }


# ---------------------------------------------------------------------------
# Account Integrity Dashboard API (Serves /dashboard and /api/v1/dashboard)
# ---------------------------------------------------------------------------
_dashboard_events: list[dict[str, Any]] = [
    {
        "id": "evt-init-01",
        "rider_id": "rider-demo-01",
        "signal": "context",
        "status": "normal",
        "severity": 0,
        "created_at": datetime.now(UTC).isoformat(),
        "detail": {
            "changes": {"location_changed": False, "device_id_changed": False},
            "risk_flags": [],
        },
    },
    {
        "id": "evt-init-02",
        "rider_id": "rider-demo-01",
        "signal": "swipe",
        "status": "normal",
        "severity": 0,
        "created_at": datetime.now(UTC).isoformat(),
        "detail": {
            "failed_features": [],
            "reason": "Swipe features within saved range",
        },
    },
    {
        "id": "evt-init-03",
        "rider_id": "rider-demo-01",
        "signal": "voice",
        "status": "verified",
        "severity": 0,
        "created_at": datetime.now(UTC).isoformat(),
        "detail": {
            "kyc_similarity": 0.884,
            "layers": {
                "kyc_speaker_match": {"status": "passed", "reason": "Cosine similarity 0.884 >= 0.25"},
            },
        },
    },
]


def record_dashboard_event(
    rider_id: str,
    signal: str,
    status: str,
    severity: int,
    detail: dict[str, Any],
) -> None:
    event = {
        "id": f"evt-{uuid4().hex[:8]}",
        "rider_id": rider_id,
        "signal": signal,
        "status": status,
        "severity": severity,
        "created_at": datetime.now(UTC).isoformat(),
        "detail": detail,
    }
    _dashboard_events.insert(0, event)
    if len(_dashboard_events) > 500:
        _dashboard_events.pop()


@app.get("/api/v1/dashboard")
def get_dashboard_summary(limit: int = 200) -> dict[str, Any]:
    events = _dashboard_events[:limit]
    total = len(events)
    alerts = sum(1 for e in events if e.get("status") in ("alert", "failed"))
    reviews = sum(1 for e in events if e.get("status") in ("alert", "review", "warn", "step_up", "failed"))
    riders_with_concerns = len({e.get("rider_id") for e in events if e.get("status") in ("alert", "review", "warn", "step_up", "failed")})
    counts = {"context": 0, "swipe": 0, "voice": 0}
    for e in events:
        sig = e.get("signal", "")
        if sig in counts:
            counts[sig] += 1
    return {
        "total_checks": total,
        "alerts": alerts,
        "needs_review": reviews,
        "riders_with_concerns": riders_with_concerns,
        "signal_counts": counts,
        "events": events,
    }


@app.get("/dashboard")
@app.get("/dashboard/")
def serve_dashboard():
    dashboard_path = Path(__file__).resolve().parents[2] / "dashboard" / "index.html"
    if dashboard_path.exists():
        return FileResponse(str(dashboard_path))
    raise HTTPException(status_code=404, detail="Dashboard index.html not found")

