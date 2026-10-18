from __future__ import annotations

import hashlib
import hmac
import json
import math
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .config import Settings
from .schemas import DetectedFace


DETECTOR_SIZE = 232_589
DETECTOR_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
EMBEDDING_SIZE = 261_036_388
EMBEDDING_SHA384 = (
    "4bceb34ee96c7c0b544012be53870d757f332d9d2972962065618de6942cf60"
    "f63b94f702f85fcc31844b21de326ec72"
)
SUPPORTED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
ARCFACE_REFERENCE = np.asarray(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


class InvalidImageError(ValueError):
    pass


class InvalidFaceError(ValueError):
    pass


class FaceEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        verify_model_file(
            settings.detector_model,
            DETECTOR_SIZE,
            "sha256",
            DETECTOR_SHA256,
        )
        verify_model_file(
            settings.embedding_model,
            EMBEDDING_SIZE,
            "sha384",
            EMBEDDING_SHA384,
        )
        self._signature_key = hashlib.sha256(
            b"luminex-face-detection-v1\0" + settings.api_key.encode("utf-8")
        ).digest()
        self._detector = cv2.FaceDetectorYN.create(
            str(settings.detector_model),
            "",
            (320, 320),
            settings.detection_threshold,
            settings.nms_threshold,
            settings.top_k,
        )
        self._embedding_net = cv2.dnn.readNetFromONNX(str(settings.embedding_model))
        self._embedding_net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self._embedding_net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self._detector_lock = threading.Lock()
        self._embedding_lock = threading.Lock()

    def detect(self, image_bytes: bytes, mime_type: str) -> list[dict[str, Any]]:
        image = decode_image(image_bytes, mime_type, self.settings)
        height, width = image.shape[:2]
        detection_image = resize_for_detection(image, self.settings.detection_max_edge)
        detection_height, detection_width = detection_image.shape[:2]

        with self._detector_lock:
            self._detector.setInputSize((detection_width, detection_height))
            _, rows = self._detector.detect(detection_image)

        if rows is None:
            return []

        image_digest = hashlib.sha256(image_bytes).hexdigest()
        faces: list[dict[str, Any]] = []
        for row in rows:
            face = row_to_face(row, detection_width, detection_height)
            face["detectionId"] = sign_detection(
                self._signature_key,
                image_digest,
                face,
            )
            faces.append(face)
        return faces

    def embed(
        self,
        image_bytes: bytes,
        mime_type: str,
        face: DetectedFace,
    ) -> list[float]:
        image = decode_image(image_bytes, mime_type, self.settings)
        image_digest = hashlib.sha256(image_bytes).hexdigest()
        face_payload = face.model_dump(by_alias=True)
        expected = sign_detection(self._signature_key, image_digest, face_payload)
        if not hmac.compare_digest(face.detectionId, expected):
            raise InvalidFaceError("face detection does not belong to this image")

        source_points = alignment_points(face, image.shape[1], image.shape[0])
        transform, _ = cv2.estimateAffinePartial2D(
            source_points,
            ARCFACE_REFERENCE,
            method=cv2.LMEDS,
        )
        if transform is None or not np.isfinite(transform).all():
            raise InvalidFaceError("face landmarks cannot be aligned")
        aligned = cv2.warpAffine(
            image,
            transform,
            (112, 112),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0),
        )
        blob = build_embedding_blob(aligned)
        with self._embedding_lock:
            self._embedding_net.setInput(blob)
            raw = self._embedding_net.forward()
        vector = np.asarray(raw, dtype=np.float32).reshape(-1)
        if vector.size != 512 or not np.isfinite(vector).all():
            raise RuntimeError("embedding model returned an invalid vector")
        magnitude = float(np.linalg.norm(vector))
        if not math.isfinite(magnitude) or magnitude <= 1e-12:
            raise RuntimeError("embedding model returned a zero vector")
        vector /= magnitude
        return [float(value) for value in vector]


def build_embedding_blob(aligned: np.ndarray) -> np.ndarray:
    """Build the raw RGB tensor expected by the Open Model Zoo ONNX graph.

    This particular graph performs ``(pixel - 127.5) / 128`` internally.
    Normalizing here as well collapses embeddings for unrelated faces, so the
    service deliberately supplies unscaled 0..255 pixels.
    """
    return cv2.dnn.blobFromImage(
        aligned,
        scalefactor=1.0,
        size=(112, 112),
        mean=(0.0, 0.0, 0.0),
        swapRB=True,
        crop=False,
    )


def decode_image(image_bytes: bytes, mime_type: str, settings: Settings) -> np.ndarray:
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise InvalidImageError("only JPEG, PNG, and WebP images are supported")
    if not image_bytes or len(image_bytes) > settings.max_image_bytes:
        raise InvalidImageError("image is empty or exceeds the byte limit")
    if sniff_mime_type(image_bytes) != mime_type:
        raise InvalidImageError("image content does not match its MIME type")

    encoded = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None or image.ndim != 3 or image.shape[2] != 3:
        raise InvalidImageError("image could not be decoded")
    height, width = image.shape[:2]
    if height < 8 or width < 8 or height * width > settings.max_image_pixels:
        raise InvalidImageError("image dimensions are outside the supported range")
    return image


def sniff_mime_type(image_bytes: bytes) -> str | None:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if (
        len(image_bytes) >= 12
        and image_bytes.startswith(b"RIFF")
        and image_bytes[8:12] == b"WEBP"
    ):
        return "image/webp"
    return None


def resize_for_detection(image: np.ndarray, max_edge: int) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(1.0, max_edge / max(height, width))
    if scale >= 1.0:
        return image
    return cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def row_to_face(row: np.ndarray, width: int, height: int) -> dict[str, Any]:
    values = np.asarray(row, dtype=np.float64).reshape(-1)
    if values.size < 15 or not np.isfinite(values[:15]).all():
        raise RuntimeError("detector returned an invalid face row")

    x = float(np.clip(values[0] / width, 0, 1))
    y = float(np.clip(values[1] / height, 0, 1))
    right = float(np.clip((values[0] + values[2]) / width, 0, 1))
    bottom = float(np.clip((values[1] + values[3]) / height, 0, 1))
    if right <= x or bottom <= y:
        raise RuntimeError("detector returned an empty face box")

    def point(kind: str, offset: int) -> dict[str, Any]:
        return {
            "kind": kind,
            "x": round(float(np.clip(values[offset] / width, 0, 1)), 8),
            "y": round(float(np.clip(values[offset + 1] / height, 0, 1)), 8),
        }

    return {
        "detectionId": "pending",
        "boundingBox": {
            "x": round(x, 8),
            "y": round(y, 8),
            "width": round(right - x, 8),
            "height": round(bottom - y, 8),
        },
        "confidence": round(float(np.clip(values[14], 0, 1)), 8),
        # YuNet order: right eye, left eye, nose, right mouth, left mouth.
        "landmarks": [
            point("right_eye", 4),
            point("left_eye", 6),
            point("nose", 8),
            point("mouth_right", 10),
            point("mouth_left", 12),
        ],
    }


def alignment_points(face: DetectedFace, width: int, height: int) -> np.ndarray:
    by_kind = {landmark.kind: landmark for landmark in face.landmarks}
    eyes = sorted(
        [by_kind["left_eye"], by_kind["right_eye"]],
        key=lambda landmark: landmark.x,
    )
    mouths = sorted(
        [by_kind["mouth_left"], by_kind["mouth_right"]],
        key=lambda landmark: landmark.x,
    )
    ordered = [eyes[0], eyes[1], by_kind["nose"], mouths[0], mouths[1]]
    return np.asarray(
        [[landmark.x * width, landmark.y * height] for landmark in ordered],
        dtype=np.float32,
    )


def sign_detection(key: bytes, image_digest: str, face: dict[str, Any]) -> str:
    geometry = {
        "boundingBox": face["boundingBox"],
        "confidence": face["confidence"],
        "landmarks": face["landmarks"],
    }
    canonical = json.dumps(
        geometry,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    signature = hmac.new(
        key,
        image_digest.encode("ascii") + b"\0" + canonical,
        hashlib.sha256,
    ).hexdigest()
    return f"v1.{signature}"


def verify_model_file(
    path: Path,
    expected_size: int,
    algorithm: str,
    expected_digest: str,
) -> None:
    if not path.is_file():
        raise RuntimeError(f"required face model is missing: {path}")
    if path.stat().st_size != expected_size:
        raise RuntimeError(f"face model has an unexpected size: {path.name}")
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if not hmac.compare_digest(digest.hexdigest(), expected_digest):
        raise RuntimeError(f"face model checksum verification failed: {path.name}")
