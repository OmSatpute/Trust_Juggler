# Mobile demo app

Expo SDK 57 app for a rider voice-check demo. SDK 57 is pinned to match the Expo Go physical-device workflow during the current SDK 58 transition. The microphone is requested on startup. Background recording is disabled; guided enrollment captures five separate 10-second clips and uploads each M4A file to FastAPI. **Call Customer** remains an 8-second single-sample check against the combined five-clip enrollment baseline. The result shows an explicit rider voice match verdict separately from the overall system verdict.

## Configure and run

1. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_BASE_URL` to the FastAPI origin reachable from the phone (for example, a separate HTTPS tunnel to port 8000). The app sends only audio and rider/batch metadata.
2. Start the backend from the repository root using the instructions in `backend/README.md`. Ensure the selected `rider_id` has a voice enrollment.
3. From this directory, run `npx expo start --tunnel` and scan the QR code with Expo Go on Android.
4. Tap **Enroll Five Voice Samples** once. Speak naturally for each 10-second clip, using different sentences in the same quiet setting and keeping the phone position steady. The app uploads the clips sequentially and saves a baseline from all five embeddings. Tap **Call Customer** to record an 8-second sample from the person being checked; its KYC similarity is computed against the full five-embedding profile. Repeat Call Customer with the enrolled rider and with other speakers to compare the results.

Expo's tunnel only exposes Metro for the QR/dev app. It does not expose FastAPI, so the configured API URL must reach the backend independently. Avoid exposing the demo backend publicly without access controls.

The mobile request contract matches the backend: each enrollment clip sends `audio`, `rider_id`, `batch_id`, and zero-based `sample_index` to `/api/v1/enrollments/batch-samples`; after five clips the API atomically replaces the in-memory KYC profile with all five ECAPA embeddings. Call Customer sends `audio`, `rider_id`, `call_label`, and `shift_id` to `/api/v1/voice-check`. The app displays the backend verdict, median cosine similarity to the five samples, each reference score and score spread, VAD reduction, detected speech duration, and layer explanations. The scores are not probabilities. The app never requests or validates customer PIN/OTP values on the call. Shift similarity remains a separate signal from Call #1.

## Device notes

- `expo-audio` uses `RecordingPresets.HIGH_QUALITY`: M4A/AAC on Android/iOS and WebM on web. The backend decodes both.
- The first backend enrollment downloads the SpeechBrain ECAPA-TDNN model. Run one enrollment with internet before an offline demo; the model is cached in the repository-root `models/speechbrain-ecapa` directory by default.
- Android must grant microphone permission. Recording is foreground-only; background recording permissions/services are intentionally not enabled. A longer capture can improve embedding stability but cannot replace threshold calibration on representative samples.
- Keep the phone and backend on a reachable network. A campus network may block direct laptop access; in that case use separate Expo and FastAPI tunnels.
