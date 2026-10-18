# Backend setup

Requires Python 3.13 for the current laptop setup. From the repository root:

```powershell
uv venv --python 3.13 .venv --cache-dir .uv-cache
uv pip install --python .venv\Scripts\python.exe -r requirements.lock.txt --cache-dir .uv-cache
Copy-Item .env.example .env
```

On macOS/Linux, use `.venv/bin/python` instead of `.venv\Scripts\python.exe`.

The backend uses SpeechBrain's pretrained ECAPA-TDNN speaker-verification model (`speechbrain/spkrec-ecapa-voxceleb`). The weights are downloaded on first use and cached under `models/speechbrain-ecapa`; first enrollment therefore needs internet access. Preload the model before an offline demo. Inference uses CPU by default; set `VOICE_MODEL_THREADS` to tune CPU threads.

Start the API from the repository root with:

```powershell
.venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

`GET /health` is lightweight. `POST /api/v1/enrollments` remains a legacy one-clip enrollment route for API compatibility and stores a normalized ECAPA embedding. The mobile demo uses the five-clip batch route described below. `GET /api/v1/enrollments/{rider_id}` reports whether a baseline exists and its sample count. Restarting the server clears enrollments.

`POST /api/v1/account-sessions` accepts JSON `{ "rider_id", "session_id", "telemetry": { "ip", "device_id", "lat", "lon", "risk_flags", "simulated" } }`. It compares a live reading with that account's latest prior session, records it in `data/account_sessions.sqlite3`, and returns baseline status plus `IP_CHANGED`, `DEVICE_CHANGED`, and/or travel/context flags. The SQLite history survives backend restarts; remove the database file to reset it. Simulated payloads are rejected. This demo endpoint has no authentication, so keep it on a trusted network.

Open `http://<computer-lan-ip>:8000/dashboard` for the Trust Operations dashboard. `GET /api/v1/dashboard` returns recorded context, swipe, voice, and pickup-counter face checks with summary counts, a recent activity list, signal concern totals, and rider identifiers for filtering. Each check is logged in the same SQLite file; context details store change flags (not the raw IP or coordinates), swipe details store changed feature names, voice details store verdict-layer explanations and ECAPA similarity, and pickup events store order/partner IDs, result, similarity/threshold, model version, and reason. The radar chart compares the most recent and preceding check per signal; its 0/65/100 values represent clear/review/alert categories, not an identity confidence score. The dashboard refreshes every 2 seconds. It is intended for a trusted demo network and has no operator authentication.

The sibling `Hack_forge_2` face-verification service can post order pickup results to `POST /api/v1/pickup-events`. Configure its `TRUST_DASHBOARD_EVENT_URL` as `http://127.0.0.1:8000/api/v1/pickup-events`. Match results count as passed; mismatches count as alerts; no-face and multiple-face outcomes go to review. The endpoint never accepts or stores face images or embedding templates.

`GET /api/v1/shifts/{rider_id}/{shift_id}` returns the in-memory call timeline for that rider and shift. The mobile demo's primary identity comparison is against five separate KYC enrollment clips; the shift comparison is an independent secondary signal.

`POST /api/v1/enrollments/batch-samples` accepts `audio`, `rider_id`, `batch_id`, and zero-based `sample_index` as multipart fields. Send indices 0 through 4 with one stable batch ID. The first four responses report `status=collecting`; the fifth response reports `status=complete` and includes the enrollment. Each clip is processed independently and its normalized ECAPA embedding is added to the five-sample KYC profile. A new batch replaces the existing baseline. At least two seconds of detected speech are required per clip. The temporary batch is in memory and is discarded after completion or backend restart.

`POST /api/v1/voice-check` accepts `audio`, `rider_id`, `call_label`, and `shift_id` as multipart form fields and remains the single-sample **Call Customer** check. The ECAPA-TDNN embedding is compared separately with each of the five enrolled embeddings; the median cosine similarity determines the KYC band, and the response includes all five scores and their spread. Input is decoded and resampled to mono 16 kHz by PyAV. WebRTC VAD removes non-speech portions while preserving the original speech bandwidth; at least two seconds of detected speech are required. The response reports the speaker model, detected speech duration, VAD reduction, KYC/shift similarities, per-layer status, and aggregate verdict. It does not ask for, verify, or require a customer PIN/OTP. The displayed cosine similarity is not a calibrated probability or percentage confidence.

SpeechBrain's published ECAPA VoxCeleb verifier uses cosine threshold `0.25`; this project uses it as the provisional pass threshold and `0.15` for step-up. Set `KYC_MATCH_THRESHOLD` and `KYC_STEP_UP_THRESHOLD` in `.env` to override them. These are not calibrated for delivery riders, Android microphones, or campus/street noise. The five clips should be recorded with varied natural speech and steady phone placement. A score is only a model similarity signal. A credible acceptance threshold requires a held-out set of same-rider and different-rider recordings from the actual capture path. Verdict precedence is alert (any alert/failed layer), pending (any required layer pending), step-up (any warning), then verified (all passed). A short/no-speech upload returns HTTP 422 and should be recorded again. `0.0.0.0` makes the service listen on network interfaces; use an authenticated/restricted tunnel before exposing it outside the laptop.

KYC and shift similarity bands default to `0.25` pass and `0.15` step-up to align provisionally with SpeechBrain's published ECAPA cosine decision threshold. These settings have not been calibrated on our target phone/riders and can cause false accepts or rejects. Build a held-out set of same-rider and different-rider phone recordings, inspect per-enrollment score distributions, then tune thresholds before relying on the verdict. `0.0.0.0` makes the service listen on network interfaces; use an authenticated/restricted tunnel before exposing it outside the laptop.
