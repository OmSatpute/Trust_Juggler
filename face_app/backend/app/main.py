from __future__ import annotations

import json
import math
import os
import sqlite3
import asyncio
import uuid
import random
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
MAX_IMAGE_BYTES = 12 * 1024 * 1024
FACE_ENGINE: FaceEngine | None = None
DASHBOARD_API_URL = os.getenv("DASHBOARD_API_URL", "http://127.0.0.1:8000")


def _forward_to_dashboard(payload: dict) -> None:
    try:
        import urllib.request
        url = f"{DASHBOARD_API_URL.rstrip('/')}/api/v1/dashboard/events"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=1.5):
            pass
    except Exception as exc:
        print(f"[FaceEngine -> Dashboard] Notice: event forwarding skipped ({exc})")


async def notify_dashboard_event(payload: dict) -> None:
    try:
        await asyncio.to_thread(_forward_to_dashboard, payload)
    except Exception:
        pass


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


@app.delete("/api/partners/{partner_id}")
async def delete_partner(partner_id: str):
    global PARTNERS, ORDERS
    partner = next((p for p in PARTNERS if p["id"] == partner_id), None)
    if not partner:
        raise HTTPException(status_code=404, detail="Partner not found.")

    # Remove partner from memory
    PARTNERS = [p for p in PARTNERS if p["id"] != partner_id]
    # Remove associated orders
    ORDERS = [o for o in ORDERS if o.get("partner_id") != partner_id]

    conn = db()
    try:
        conn.execute("DELETE FROM enrollments WHERE partner_id=?", (partner_id,))
        conn.execute("DELETE FROM custom_partners WHERE id=?", (partner_id,))
        conn.execute("DELETE FROM custom_orders WHERE partner_id=?", (partner_id,))
        conn.commit()
    finally:
        conn.close()

    return {"status": "deleted", "partner_id": partner_id}


@app.get("/api/orders")
async def orders():
    return {"orders": ORDERS}


class CreateOrderPayload(BaseModel):
    items: str = "2 items · 10 min"
    partner_id: str
    customer: str = "Customer"


@app.post("/api/orders")
async def create_order(payload: CreateOrderPayload):
    global ORDERS
    order_id = f"HF-{random.randint(2100, 2999)}"
    new_o = {
        "id": order_id,
        "customer": payload.customer,
        "items": payload.items,
        "partner_id": payload.partner_id,
        "state": "Ready for pickup",
    }
    ORDERS.insert(0, new_o)

    conn = db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO custom_orders(id, customer, items, partner_id, state) VALUES(?, ?, ?, ?, ?)",
            (order_id, new_o["customer"], new_o["items"], new_o["partner_id"], new_o["state"]),
        )
        conn.commit()
    finally:
        conn.close()

    return {"order": new_o}


@app.delete("/api/orders/{order_id}")
async def delete_order(order_id: str):
    global ORDERS
    order = next((o for o in ORDERS if o["id"] == order_id), None)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found.")

    ORDERS = [o for o in ORDERS if o["id"] != order_id]

    conn = db()
    try:
        conn.execute("DELETE FROM custom_orders WHERE id=?", (order_id,))
        conn.commit()
    finally:
        conn.close()

    return {"status": "deleted", "order_id": order_id}


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

    await notify_dashboard_event({
        "rider_id": partner_name,
        "signal": "face",
        "status": "baseline",
        "severity": 0,
        "detail": {
            "partner_name": partner_name,
            "partner_id": partner_id,
            "result": "enrolled",
            "reason": f"ArcFace 512D baseline biometrics enrolled for {partner_name}.",
            "verdict": "enrolled",
        },
    })

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
        await notify_dashboard_event({
            "rider_id": assigned_name,
            "signal": "face",
            "status": "review",
            "severity": 30,
            "detail": {
                "partner_name": assigned_name,
                "partner_id": order["partner_id"],
                "order_id": order_id,
                "result": "no_face",
                "reason": "No face detected in camera frame. Center face inside the oval.",
                "verdict": "no_face",
            },
        })
        return {
            "result": "no_face",
            "reason": "No face detected in camera frame. Center face inside the oval.",
            "order_id": order_id,
            "assigned_partner_id": order["partner_id"],
            "assigned_partner_name": assigned_name,
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
        reason_msg = f"Multiple people detected ({len(faces)} faces in frame). Another person is behind or nearby. Verification paused — only assigned partner {assigned_name} must be in camera view."
        await notify_dashboard_event({
            "rider_id": assigned_name,
            "signal": "face",
            "status": "alert",
            "severity": 100,
            "detail": {
                "partner_name": assigned_name,
                "partner_id": order["partner_id"],
                "order_id": order_id,
                "face_count": len(faces),
                "result": "multiple_faces",
                "reason": reason_msg,
                "verdict": "alert",
            },
        })
        return {
            "result": "multiple_faces",
            "face_count": len(faces),
            "reason": reason_msg,
            "order_id": order_id,
            "assigned_partner_id": order["partner_id"],
            "assigned_partner_name": assigned_name,
            "boxes": boxes,
            "box": boxes[0],
        }

    detected_face = DetectedFace.model_validate(faces[0])
    vector = await asyncio.to_thread(FACE_ENGINE.embed, image_bytes, image.content_type or "", detected_face)
    if len(vector) != 512 or not all(math.isfinite(float(v)) for v in vector):
        raise HTTPException(status_code=500, detail="ArcFace returned an invalid embedding.")

    similarity = cosine(vector, json.loads(row[0]))
    is_match = similarity >= THRESHOLD
    box = detected_face.boundingBox.model_dump()
    status_str = "verified" if is_match else "alert"
    severity_val = 0 if is_match else 100
    reason_str = (
        f"Biometrics verified. {assigned_name} is authorized for pickup."
        if is_match
        else f"Face mismatch: The person in frame does not match registered biometrics for {assigned_name}."
    )
    confidence_val = round((75 + ((similarity - THRESHOLD) / (1.0 - THRESHOLD)) * 24.5), 1) if is_match else round((max(0.0, similarity) / THRESHOLD * 60), 1)

    await notify_dashboard_event({
        "rider_id": assigned_name,
        "signal": "face",
        "status": status_str,
        "severity": severity_val,
        "detail": {
            "partner_name": assigned_name,
            "partner_id": order["partner_id"],
            "order_id": order_id,
            "similarity": round(similarity, 4),
            "threshold": THRESHOLD,
            "confidence_pct": confidence_val,
            "result": "match" if is_match else "mismatch",
            "reason": reason_str,
            "verdict": status_str,
        },
    })

    return {
        "result": "match" if is_match else "mismatch",
        "similarity": round(similarity, 4),
        "threshold": THRESHOLD,
        "order_id": order_id,
        "assigned_partner_id": order["partner_id"],
        "assigned_partner_name": assigned_name,
        "model_version": DEFAULT_MODEL_VERSION,
        "box": box,
        "boxes": [box],
        "reason": reason_str,
        "note": "Demo similarity score; threshold is not calibrated for operational use.",
    }
