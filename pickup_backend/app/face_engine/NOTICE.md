This folder vendors the YuNet detection and ArcFace embedding implementation
from the local `FaceRecog/face-service` project for use inside the Part 2 API.

The model files are downloaded separately by `backend/scripts/download-models.ps1`:

- `face_detection_yunet_2023mar.onnx` is from OpenCV Zoo's YuNet model (MIT).
- `arcfaceresnet100-8.onnx` is Open Model Zoo's ArcFace ResNet-100 ONNX model
  (Apache-2.0, as documented by Open Model Zoo).

See the upstream model repositories for full license terms:

- https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/public/face-recognition-resnet100-arcface-onnx
