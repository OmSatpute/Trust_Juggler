# Rider Voice Verification Demo Runbook

This runbook rehearses the current API and Expo app. Scores/thresholds are provisional demo signals, not proof of identity or liveness.

## Before the demo

1. Install the Python backend from the root instructions in `backend/README.md` and the mobile dependencies with `cd mobile; npm ci`.
2. Copy `mobile/.env.example` to `mobile/.env`; set `EXPO_PUBLIC_API_BASE_URL` to a FastAPI URL the phone can reach.
3. Start FastAPI from the project root:

   ```powershell
   .venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```

4. Start Expo in another terminal from `mobile/`:

   ```powershell
   npx expo start --tunnel
   ```

5. Scan the QR code in Expo Go on Android. Grant microphone access. Expo's tunnel carries the app bundle only; it does not expose FastAPI. Use a separate secured backend tunnel, or use the laptop's LAN IP when the phone and laptop share a network. Do not use `localhost` as the phone's backend host.

## Normal verification narrative

1. Tap **Enroll Five Voice Samples** once. The rider records five separate 10-second clips, using different natural sentences and a consistent phone position. The app uploads them in sequence; the backend saves all five normalized embeddings as the KYC baseline after the fifth clip.
2. Tap **Call Customer** and speak for 8 seconds as the enrolled rider. Review the direct rider voice verdict and KYC similarity, which compare this call sample against the five-clip baseline.
3. Tap **Call Customer** again and have a teammate speak naturally. Compare the teammate's KYC similarity and explicit rider voice verdict with the enrolled rider's result. Repeat with more voices as desired; each Call Customer check is a fresh single clip and does not replace the five-sample baseline.
4. Review the median similarity against all five enrollment clips, the five individual scores, score spread, VAD reduction, detected speech duration, shift similarity, layer statuses, and aggregate verdict. Changed-speaker similarity may or may not cross provisional bands; do not promise a guaranteed red verdict before collecting and evaluating rider-specific samples.

No customer PIN/OTP should be requested or read out during calls. If a real policy-approved step-up is needed, it belongs in an app flow outside this call recording.

## Offline model drill

The speaker model runs locally through SpeechBrain/PyTorch after its first download. Keep the backend laptop offline after a successful model load and verify that a Call Customer request still returns a speaker result while the phone can reach the laptop on LAN. A public tunnel or Expo development bundle may stop working without internet, so load the app first and use a local network path for the API.

## Reset

Stop and restart FastAPI to clear in-memory KYC enrollments and shift timelines, then re-enroll the demo rider. Keep the same `rider_id` between enrollment and voice-check calls.

## Current limits

- Five-clip enrollment, thresholds, and shift timeline are in memory; a restart clears them.
- The SpeechBrain model is pretrained on VoxCeleb, not a delivery-rider or target-device dataset. Its thresholds need calibration using held-out same-rider and different-rider samples recorded through the Android app.
- Speaker similarity alone cannot establish liveness or reliably defeat high-quality replay and voice-cloning attacks.
- The app has not yet been exercised on the physical Android phone or through the actual backend tunnel with the ECAPA model.
