from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


# The preprocessing revision is part of the model identity. Changing either
# the weights or the pixel transform requires re-indexing existing photos.
DEFAULT_MODEL_VERSION = "arcface-r100-onnx8-omz-2022.1-raw-rgb-v2"


@dataclass(frozen=True)
class Settings:
    api_key: str
    detector_model: Path
    embedding_model: Path
    model_version: str = DEFAULT_MODEL_VERSION
    max_image_bytes: int = 12 * 1024 * 1024
    max_image_pixels: int = 50_000_000
    detection_max_edge: int = 1_280
    detection_threshold: float = 0.65
    nms_threshold: float = 0.30
    top_k: int = 5_000

    @classmethod
    def from_environment(cls) -> "Settings":
        # The key is used only to bind detector geometry to the source image;
        # this in-process engine has no face-service HTTP authentication.
        api_key = os.environ.get("FACE_ENGINE_SIGNATURE_KEY", "pickup-verify-local-engine-key")
        root = Path(__file__).resolve().parents[2]
        detector_model = Path(
            os.environ.get(
                "FACE_DETECTOR_MODEL",
                root / "models" / "face_detection_yunet_2023mar.onnx",
            )
        ).resolve()
        embedding_model = Path(
            os.environ.get(
                "FACE_EMBEDDING_MODEL",
                root / "models" / "arcfaceresnet100-8.onnx",
            )
        ).resolve()

        return cls(
            api_key=api_key,
            detector_model=detector_model,
            embedding_model=embedding_model,
            model_version=os.environ.get("FACE_MODEL_VERSION", DEFAULT_MODEL_VERSION),
        )
