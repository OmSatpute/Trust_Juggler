from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


LandmarkKind = Literal[
    "left_eye",
    "right_eye",
    "nose",
    "mouth_left",
    "mouth_right",
]


class BoundingBox(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def contained_in_image(self) -> "BoundingBox":
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("bounding box extends outside the image")
        return self


class Landmark(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: LandmarkKind
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class DetectedFace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detectionId: str = Field(min_length=10, max_length=256)
    boundingBox: BoundingBox
    confidence: float = Field(ge=0, le=1)
    landmarks: list[Landmark]

    @model_validator(mode="after")
    def exactly_one_of_each_landmark(self) -> "DetectedFace":
        expected = {"left_eye", "right_eye", "nose", "mouth_left", "mouth_right"}
        kinds = [landmark.kind for landmark in self.landmarks]
        if len(kinds) != 5 or set(kinds) != expected:
            raise ValueError("exactly five unique alignment landmarks are required")
        return self

