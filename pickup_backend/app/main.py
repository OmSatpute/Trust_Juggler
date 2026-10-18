from __future__ import annotations

import json
import math
import os
import sqlite3
import asyncio
import uuid
import random
import logging
from urllib.request import Request, urlopen
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from .face_engine.config import DEFAULT_MODEL_VERSION, Settings as FaceSettings
from .face_engine.engine import FaceEngine, InvalidImageError, InvalidFaceError
from .face_engine.schemas import DetectedFace

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
DB_PATH = Path(os.getenv("DATABASE_PATH", "data/pickup_verify.sqlite3"))
if not DB_PATH.is_absolute():
    DB_PATH = ROOT / DB_PATH
THRESHOLD = float(os.getenv("MATCH_THRESHOLD", "0.45"))
DASHBOARD_EVENT_URL = os.getenv("TRUST_DASHBOARD_EVENT_URL", "").strip()
logger = logging.getLogger(__name__)
MAX_IMAGE_BYTES = 12 * 1024 * 1024
FACE_ENGINE: FaceEngine | None = None

PARTNERS = [
    {"id": "rider-01", "name": "Arnav Nisal", "vehicle": "Electric bicycle · MH 12 AB 2048", "role": "Enrolled partner"},
    {"id": "rider-02", "name": "Samarth Sathe", "vehicle": "Motorcycle · MH 12 CD 7712", "role": "Partner 2"},
    {"id": "rider-03", "name": "Om Satpute", "vehicle": "Scooter · MH 12 EF 9305", "role": "Partner 3"},
]
ORDERS = [
    {"id": "HF-2048", "customer": "N. Kapoor", "items": "2 items · 12 min", "partner_id": "rider-01", "state": "Ready for pickup"},
    {"id": "HF-2051", "customer": "S. Jain", "items": "4 items · 8 min", "partner_id": "rider-02", "state": "Ready for pickup"},
    {"id": "HF-2054", "customer": "R. Singh", "items": "1 item · 5 min", "partner_id": "rider-03", "state": "Ready for pickup"},
]


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS enrollments (partner_id TEXT PRIMARY KEY, embedding TEXT NOT NULL, model_version TEXT NOT NULL, enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    conn.execute("CREATE TABLE IF NOT EXISTS custom_partners (id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT NOT NULL, role TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS custom_orders (id TEXT PRIMARY KEY, customer TEXT NOT NULL, items TEXT NOT NULL, partner_id TEXT NOT NULL, state TEXT NOT NULL)")
    conn.commit()
    return conn


@asynccontextmanager
async def lifespan(_: FastAPI):
    global FACE_ENGINE
    conn = db()
    try:
        cur_p = conn.execute("SELECT id, name, vehicle, role FROM custom_partners").fetchall()
        existing_p_ids = {p["id"] for p in PARTNERS}
        for row in cur_p:
            if row[0] not in existing_p_ids:
                PARTNERS.append({"id": row[0], "name": row[1], "vehicle": row[2], "role": row[3]})
                existing_p_ids.add(row[0])

        cur_o = conn.execute("SELECT id, customer, items, partner_id, state FROM custom_orders").fetchall()
        existing_o_ids = {o["id"] for o in ORDERS}
        for row in cur_o:
            if row[0] not in existing_o_ids:
                ORDERS.insert(0, {"id": row[0], "customer": row[1], "items": row[2], "partner_id": row[3], "state": row[4]})
                existing_o_ids.add(row[0])
    finally:
        conn.close()

    model_dir = ROOT / "models"
    FACE_ENGINE = FaceEngine(FaceSettings(
        api_key="pickup-verify-local-engine-key",
        detector_model=model_dir / "face_detection_yunet_2023mar.onnx",
        embedding_model=model_dir / "arcfaceresnet100-8.onnx",
    ))
    yield
    FACE_ENGINE = None


app = FastAPI(title="Pickup Verify API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health():
    return {"status": "ready", "face_engine": "YuNet + ArcFace", "model_version": DEFAULT_MODEL_VERSION}


@app.get("/api/partners")
async def partners():
    conn = db()
    try:
        enrolled = {r[0] for r in conn.execute("SELECT partner_id FROM enrollments")}
    finally:
        conn.close()
    return {"partners": [{**p, "enrolled": p["id"] in enrolled} for p in PARTNERS]}


class CreatePartnerPayload(BaseModel):
    name: str
    vehicle: str = "Guest Partner · On-demand"
    role: str = "Guest Partner"


@app.post("/api/partners")
async def create_partner(payload: CreatePartnerPayload):
    clean_name = payload.name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Partner name is required.")

    partner_id = f"guest-{uuid.uuid4().hex[:6]}"
    vehicle = payload.vehicle or "Guest Partner · On-demand"
    role = payload.role or "Guest Partner"

    new_p = {"id": partner_id, "name": clean_name, "vehicle": vehicle, "role": role}
    PARTNERS.append(new_p)

    first_name = clean_name.split()[0]
    order_id = f"HF-{random.randint(2100, 2999)}"
    new_o = {
        "id": order_id,
        "customer": f"{first_name} (Guest)",
        "items": "2 items · 5 min",
        "partner_id": partner_id,
        "state": "Ready for pickup",
    }
    ORDERS.insert(0, new_o)

    conn = db()
    try:
        conn.execute("INSERT OR REPLACE INTO custom_partners(id, name, vehicle, role) VALUES(?, ?, ?, ?)", (partner_id, clean_name, vehicle, role))
        conn.execute("INSERT OR REPLACE INTO custom_orders(id, customer, items, partner_id, state) VALUES(?, ?, ?, ?, ?)", (order_id, new_o["customer"], new_o["items"], partner_id, new_o["state"]))
        conn.commit()
    finally:
        conn.close()

    return {"partner": {**new_p, "enrolled": False}, "order": new_o}


@app.get("/api/orders")
async def orders():
    return {"orders": ORDERS}


async def detect_faces(image: bytes, content_type: str) -> list[dict]:
    if FACE_ENGINE is None:
        raise HTTPException(status_code=503, detail="ArcFace engine is not ready. Restart the backend and check its startup log.")
    try:
        return await asyncio.to_thread(FACE_ENGINE.detect, image, content_type)
    except InvalidImageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except InvalidFaceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


async def read_image(image: UploadFile) -> bytes:
    data = await image.read(MAX_IMAGE_BYTES + 1)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is empty or exceeds the 12 MB limit.")
    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image.")
    return data


async def report_pickup_outcome(outcome: dict) -> None:
    """Forward a face-check result to the account-integrity dashboard API."""
    if not DASHBOARD_EVENT_URL:
        return
    payload = {
        "event_id": str(uuid.uuid4()),
        "order_id": outcome["order_id"],
        "assigned_partner_id": outcome["assigned_partner_id"],
        "assigned_partner_name": outcome["assigned_partner_name"],
        "result": outcome["result"],
        "similarity": outcome.get("similarity"),
        "threshold": outcome.get("threshold"),
        "model_version": outcome.get("model_version"),
        "reason": outcome.get("reason", ""),
    }
    body = json.dumps(payload).encode("utf-8")

    def send() -> None:
        request = Request(DASHBOARD_EVENT_URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request, timeout=1.5) as response:
            if response.status >= 300:
                raise RuntimeError(f"Dashboard endpoint returned HTTP {response.status}")

    try:
        await asyncio.wait_for(asyncio.to_thread(send), timeout=1.75)
    except Exception:
        logger.warning("Could not forward pickup verification result to dashboard", exc_info=True)


def cosine(left: list[float], right: list[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    norm_left = math.sqrt(sum(v * v for v in left))
    norm_right = math.sqrt(sum(v * v for v in right))
    if norm_left <= 0 or norm_right <= 0:
        raise HTTPException(status_code=502, detail="Invalid face embedding.")
    return dot / (norm_left * norm_right)


@app.post("/api/partners/{partner_id}/enrollment")
async def enroll(partner_id: str, image: Annotated[UploadFile, File()]):
    if partner_id not in {p["id"] for p in PARTNERS}:
        raise HTTPException(status_code=404, detail="Partner not found.")
    partner = next((p for p in PARTNERS if p["id"] == partner_id), None)
    partner_name = partner["name"] if partner else partner_id

    image_bytes = await read_image(image)
    faces = await detect_faces(image_bytes, image.content_type or "")

    if len(faces) == 0:
        return {
            "status": "no_face",
            "reason": "No face detected. Keep face centered and well-lit.",
            "boxes": [],
        }

    if len(faces) > 1:
        # Sort by bounding box area descending (largest/closest face first)
        sorted_faces = sorted(
            faces,
            key=lambda f: f["boundingBox"]["width"] * f["boundingBox"]["height"],
            reverse=True,
        )
        boxes = [f["boundingBox"] for f in sorted_faces]
        return {
            "status": "multiple_faces",
            "face_count": len(faces),
            "reason": f"Multiple people detected ({len(faces)} faces in frame). Another person is behind or nearby. Only {partner_name} must be in frame.",
            "boxes": boxes,
            "box": boxes[0],
        }

    detected_face = DetectedFace.model_validate(faces[0])
    vector = await asyncio.to_thread(FACE_ENGINE.embed, image_bytes, image.content_type or "", detected_face)
    if len(vector) != 512 or not all(math.isfinite(float(v)) for v in vector):
        raise HTTPException(status_code=500, detail="ArcFace returned an invalid embedding.")

    box = detected_face.boundingBox.model_dump()
    conn = db()
    try:
        conn.execute(
            "INSERT INTO enrollments(partner_id, embedding, model_version) VALUES(?, ?, ?) ON CONFLICT(partner_id) DO UPDATE SET embedding=excluded.embedding, model_version=excluded.model_version, enrolled_at=CURRENT_TIMESTAMP",
            (partner_id, json.dumps(vector), DEFAULT_MODEL_VERSION),
        )
        conn.commit()
    finally:
        conn.close()
    return {
        "status": "enrolled",
        "partner_id": partner_id,
        "partner_name": partner_name,
        "model_version": DEFAULT_MODEL_VERSION,
        "box": box,
        "boxes": [box],
    }


@app.post("/api/orders/{order_id}/verify")
async def verify(order_id: str, image: Annotated[UploadFile, File()]):
    order = next((item for item in ORDERS if item["id"] == order_id), None)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    conn = db()
    try:
        row = conn.execute("SELECT embedding, model_version FROM enrollments WHERE partner_id=?", (order["partner_id"],)).fetchone()
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=409, detail="The assigned partner has not been enrolled yet.")

    image_bytes = await read_image(image)
    faces = await detect_faces(image_bytes, image.content_type or "")
    partner = next((p for p in PARTNERS if p["id"] == order["partner_id"]), None)
    assigned_name = partner["name"] if partner else "Assigned Partner"

    if len(faces) == 0:
        outcome = {
            "result": "no_face",
            "reason": "No face detected in camera frame. Center face inside the oval.",
            "order_id": order_id,
            "assigned_partner_id": order["partner_id"],
            "assigned_partner_name": assigned_name,
            "boxes": [],
        }
        await report_pickup_outcome(outcome)
        return outcome

    if len(faces) > 1:
        # Sort by bounding box area descending (largest/closest face first)
        sorted_faces = sorted(
            faces,
            key=lambda f: f["boundingBox"]["width"] * f["boundingBox"]["height"],
            reverse=True,
        )
        boxes = [f["boundingBox"] for f in sorted_faces]
        outcome = {
            "result": "multiple_faces",
            "face_count": len(faces),
            "reason": f"Multiple people detected ({len(faces)} faces in frame). Another person is behind or nearby. Verification paused — only assigned partner {assigned_name} must be in camera view.",
            "order_id": order_id,
            "assigned_partner_id": order["partner_id"],
            "assigned_partner_name": assigned_name,
            "boxes": boxes,
            "box": boxes[0],
        }
        await report_pickup_outcome(outcome)
        return outcome

    detected_face = DetectedFace.model_validate(faces[0])
    vector = await asyncio.to_thread(FACE_ENGINE.embed, image_bytes, image.content_type or "", detected_face)
    if len(vector) != 512 or not all(math.isfinite(float(v)) for v in vector):
        raise HTTPException(status_code=500, detail="ArcFace returned an invalid embedding.")

    similarity = cosine(vector, json.loads(row[0]))
    is_match = similarity >= THRESHOLD
    box = detected_face.boundingBox.model_dump()
    outcome = {
        "result": "match" if is_match else "mismatch",
        "similarity": round(similarity, 4),
        "threshold": THRESHOLD,
        "order_id": order_id,
        "assigned_partner_id": order["partner_id"],
        "assigned_partner_name": assigned_name,
        "model_version": DEFAULT_MODEL_VERSION,
        "box": box,
        "boxes": [box],
        "reason": (
            f"Biometrics verified. {assigned_name} is authorized for pickup."
            if is_match
            else f"Face mismatch: The person in frame does not match registered biometrics for {assigned_name}."
        ),
        "note": "Demo similarity score; threshold is not calibrated for operational use.",
    }
    await report_pickup_outcome(outcome)
    return outcome
