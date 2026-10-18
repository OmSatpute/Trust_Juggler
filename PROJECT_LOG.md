# Project Plan and Work Log

### 2026-10-18 — Pickup face verification in Trust Operations

- **Request:** Reflect the sibling `Hack_forge_2` restaurant pickup-counter face verification output in the dashboard.
- **Changed:** Added `POST /api/v1/pickup-events` to the dashboard API, mapping face match to passed, mismatch to alert, and no-face/multiple-face to review. The event contains order and partner IDs, result, similarity/threshold, model version, and reason; it does not accept face images or embeddings.
- **Changed:** The ArcFace pickup API can forward each verification result to the dashboard endpoint using `TRUST_DASHBOARD_EVENT_URL`. Documented port 8000 for the account dashboard API and 8001 for the pickup API; updated the dashboard radar/activity feed for the fourth signal.
- **Validation:** Both Python backends passed `compileall` using the Hack_forge Python runtime. The face project's own virtualenv could not run because its configured `C:\Python314\python.exe` no longer exists. No tests or phone/face camera walkthrough run.

### 2026-10-18 — Clarify voice match versus aggregate voice verdict

- **Report:** Voice recognition appears not to identify the enrolled account holder.
- **Finding:** The mobile card used the aggregate voice verdict for its headline, so a shift-consistency alert could be presented as if the KYC speaker match itself failed.
- **Changed:** The card now reports the KYC speaker-match layer separately and displays detected speech duration and individual enrollment-reference similarities for diagnosis. Thresholds remain unchanged pending actual same-speaker scores; lowering them without those measurements could increase false matches.
- **Validation:** Mobile TypeScript typecheck passed. No phone audio was available to determine the underlying recognition accuracy.

### 2026-10-18 — Dashboard refresh interval

- **Request:** Reduce the Trust Operations dashboard refresh time to two seconds.
- **Changed:** Updated polling from 15,000 ms to 2,000 ms and corrected current runbook/backend documentation.
- **Validation:** Confirmed the old interval text/value is absent from current dashboard docs.

### 2026-10-18 — Trust Operations dashboard

- **Request:** Build a companion dashboard connected to the mobile account integrity demo, including alert/review history and a radar-style signal comparison.
- **Changed:** Added a responsive dark-theme dashboard at `/dashboard` and `GET /api/v1/dashboard`. The UI includes total check, alert, review, and affected-rider counts; a filterable activity feed; a review queue; signal concern counts; and a rider radar chart comparing latest vs previous context/swipe/voice check categories.
- **Changed:** Context, swipe, and voice check endpoints now append report events to the existing SQLite account database. Stored context reports include change flags without raw IP/coordinates; swipe reports include changed features; voice reports include layer explanations and cosine similarity. Dashboard data refreshes every 15 seconds.
- **Decision:** Radar categories are displayed as clear/review/alert levels (0/65/100), not identity confidence. The API returns summary counts for all stored events and the latest event list. Demo remains unauthenticated on the trusted LAN.
- **Validation:** Backend `compileall`, mobile TypeScript typecheck, and `git diff --check` passed. No tests or browser/device walkthrough run.

### 2026-10-18 — Purpose-built account integrity demo

- **Request:** Use the projects' concepts and backend to build a sensible demo instead of combining their screens as-is.
- **Changed:** Replaced the stitched tab UI in `mobile/App.tsx` with a single account integrity dashboard. It tells a baseline-then-session-check story using sign-in context (public IP, device description, foreground GPS), server-stored swipe features, and the existing five-clip ECAPA voice enrollment/check API. The combined assessment treats changes as review evidence and explicitly says they do not prove account sharing.
- **Changed:** Rewrote `mobile/README.md` and `DEMO_RUNBOOK.md` for the new workflow and local-network Expo start (`npx expo start --lan`). The backend must bind to `0.0.0.0`; the mobile API URL must use the computer's LAN IPv4 address.
- **Retained:** Earlier integrated screen source files remain in the repository but are not imported by the active `App.tsx`. Their deletion was blocked by automatic review; they are outside the demo entry point.
- **Validation:** TypeScript and backend syntax checks pending. No tests or device walkthrough run.

This file is the shared handoff record for the three-laptop project. Keep it in sync with code changes, decisions, and integration notes so another laptop can understand the work without relying on chat history.

**Current voice architecture:** SpeechBrain ECAPA-TDNN extracts local speaker embeddings. Five separate enrollment clips are kept as individual templates; each Call Customer clip is compared against all five and scored by the median cosine similarity. WebRTC VAD only removes silence, while the speech waveform's natural bandwidth is preserved. Whisper, Groq transcription, keyword context checks, Resemblyzer, and the old hand bandpass are removed from the active voice path. This supersedes the earlier architecture below.

## Project goal

Build a mobile audio capture and Python service demo for rider voice verification. The flow captures five enrollment clips, compares each new call against all five reference embeddings, reports match evidence, and preserves a separate shift comparison. Customer PINs/OTPs are never requested or validated on calls. Recognition scores remain provisional until calibrated with phone recordings from the target riders and environment.

## Working agreements

- Before implementation, inspect the existing app/backend structure and preserve its conventions. This repository was empty when this plan was written.
- Record each meaningful change under **Work log**, including date, laptop/author if known, paths changed, behavior, and validation performed. Record decisions and unresolved questions under **Decisions and assumptions**.
- Keep local secrets and downloaded model weights out of source control. The current voice-check path requires no API keys; backend configuration remains in an untracked `.env`.
- Keep audio transport and backend configuration environment-driven. Expo Go's `--tunnel` exposes the Expo development server; it does not automatically expose a separate FastAPI backend. The phone needs a reachable backend URL (for example, a separately configured tunnel) and the backend should restrict access appropriately.
- Build in small increments with clear interfaces between mobile capture, API, audio processing, and dashboard. Commit/describe changes so the three branches can be integrated by feature area.
- Treat speaker similarity and replay metrics as demo signals until thresholds are measured against representative samples. Do not present them as proven security guarantees.

## Current integration contract — five-clip enrollment

- Mobile `Enroll Five Voice Samples` records five independent 10-second M4A clips and uploads them sequentially to `POST /api/v1/enrollments/batch-samples`.
- Multipart fields: `audio`, `rider_id`, one stable unique `batch_id`, and zero-based `sample_index` from 0 through 4.
- Responses 1–4 have `status: collecting` and `samples_received`; response 5 has `status: complete` and an `enrollment` object with `sample_count: 5`.
- Backend stores the five normalized SpeechBrain ECAPA-TDNN embeddings as separate KYC templates. Each new call is compared against every template; the median cosine score drives the provisional KYC band and all five scores plus spread are returned. A new completed five-clip batch replaces the prior profile.
- `Call Customer` remains a single 8-second clip and continues to send `audio`, `rider_id`, `call_label`, and `shift_id` to `/api/v1/voice-check`. It does not mutate enrollment.
- Both enrollment profile and in-progress batches are in-memory and clear when FastAPI restarts. A failed/abandoned batch is not saved as the baseline; restart clears incomplete temporary batches.
- The speaker model downloads from Hugging Face on first use and is cached at `models/speechbrain-ecapa` by default. Prime it with network access before an offline run. No ASR/transcript/Groq/Whisper dependency is part of the current API.
- SpeechBrain's documented verifier default cosine threshold is 0.25. The current `0.25` pass and `0.15` step-up bands are provisional only; calibrate against held-out same-rider and different-rider samples recorded on the actual phone.

## Original phased implementation plan (historical)

The original plan below included Resemblyzer and hybrid Whisper. Those decisions have been superseded by the current architecture at the top of this file; use the current integration contract when integrating laptops.

### Phase 0 — Repository and interface baseline

1. Inventory the existing mobile and backend code, environment setup, and run commands; identify the app entry point and API boundary.
2. Agree on the API contract: upload field names, audio format/sample rate, rider identifier, call label/slot, and response schema for verdict and telemetry. Do not include a spoken PIN/OTP challenge.
3. Define configuration and local setup instructions for Python, Expo, model downloads, and separate phone-to-backend connectivity.
4. Decide where enrollment embeddings and per-shift call history live for the demo (in-memory initially unless the existing project already provides storage).

**Gate:** Mobile and backend owners can implement independently against one written request/response contract.

### Phase 1 — Local environment and audio pipeline

1. Inspect the Python version and existing dependency manager; install/record compatible versions of FastAPI, Resemblyzer, faster-whisper, Groq SDK, librosa, and audio/VAD dependencies. Avoid replacing the project's package manager.
2. Add the narrowly scoped NumPy compatibility patch before the Resemblyzer/WebRTC VAD path is initialized; document the NumPy version it addresses.
3. Implement a transcription adapter: Groq `whisper-large-v3-turbo` as primary, local faster-whisper `base`/`int8` as fallback on network, rate-limit, or service errors. Keep API key in environment configuration and make fallback selection visible in telemetry.
4. Document model download, first-run latency, CPU/RAM expectations, and the local command to start the backend.
5. Install Expo Go on the physical Android demo device; run the app with `npx expo start --tunnel`. Separately make FastAPI reachable from the phone and configure the app's backend URL.

**Gate:** Backend starts locally; transcription adapter can select both providers; phone can reach the configured API endpoint.

### Phase 2 — Mobile capture and upload

1. Request microphone permission at startup and configure an audio recording session suitable for clear speech. Confirm platform-specific background behavior before enabling background recording permissions; the core demo should work in foreground.
2. Add the “Call Customer (Masked Bridge)” action to the active order card. On tap, start recording, stop automatically after four seconds, and upload once; prevent duplicate taps and clean up on errors/unmount.
3. Build a multipart request containing the audio plus `rider_id` and `call_label`/shift slot. Keep backend URL configurable rather than hardcoding a temporary tunnel URL. Do not ask riders to solicit customer OTP/PIN values on calls.
4. Present capture/upload/loading/error states and handle denied permission, network failure, and empty/invalid recording gracefully.

**Gate:** A physical phone can submit one 4-second sample and receive a structured backend response.

### Phase 3 — Four validation layers

Process audio in a documented, observable order and return per-layer results:

1. **Audio cleanup:** Decode and validate input, apply 85–3400 Hz Butterworth bandpass, run WebRTC VAD, and calculate speech/noise reduction. Handle too-short or speech-free samples.
2. **KYC speaker match:** Extract the 256-dimensional Resemblyzer embedding from cleaned speech and compare it to an enrollment baseline with cosine similarity. Define enrollment input and keep threshold configurable pending calibration.
3. **Shift consistency:** Keep a shift-scoped timeline per rider, compare each call to Call #1, and flag a configurable similarity drop. Reset/advance shift state explicitly; do not mix riders or shifts.
4. **Liveness and context:** Calculate spectral flatness and high-frequency roll-off as replay indicators; transcribe with the hybrid adapter; check delivery-call context without requesting or validating a customer PIN/OTP. Return evidence/metrics separately from the final decision.

**Gate:** API response explains each layer's result, provider, and failure state; thresholds and demo data are configurable.

### Phase 4 — Dashboard and judge demo

1. Map backend verdicts to green verified, amber in-app step-up, and red suspected hand-off/replay banners. Show trust score, similarity to Call #1, VAD reduction, transcript, and transcription provider.
2. Add the four demo slots (Call #1 10:00 AM, Call #2 12:30 PM, Call #3 2:15 PM, Call #4 4:30 PM) with a tap-to-advance selector. Make the identity input/sample controllable so the final slot can demonstrate a different speaker.
3. Prepare a short demo script: enroll rider, pass Calls 1–3, and test a changed speaker on Call 4. Demonstrate local transcription fallback while preserving phone-to-backend connectivity (for example, with a local backend and Groq unavailable); disconnecting all laptop networking also disconnects a phone that depends on its tunnel. Avoid promising fallback for cloud-only services; speaker processing is local already.
4. Verify the complete flow on the target phone and laptop, including permissions, tunnel connectivity, visible errors, and offline behavior. Capture known limitations and reset steps for the next demo run.

**Gate:** Demo can be reset and repeated reliably, and the displayed verdict matches the API response.

## Original provisional API contract (historical)

Use this shared interface unless inspection by the other contributors reveals an existing contract to preserve:

- `POST /api/v1/voice-check` — `multipart/form-data` with `audio` (Expo mobile default M4A/AAC; also accept WAV and web WebM), `rider_id`, `call_label`, and `shift_id`. Decode and convert server-side to mono 16 kHz samples before filtering/VAD; do not require the mobile app to re-encode.
- Return JSON with `verdict` (`pending`, `verified`, `step_up`, or `alert`), nullable `voice_trust_score`, `kyc_similarity`, `shift_similarity`, `vad_noise_reduction_pct`, `spectral_flatness`, `high_frequency_rolloff_hz`, `replay_risk`, and `delivery_keyword_found`, plus `transcript`, `transcription_provider`, `layers` (one status and brief reason per layer), and `request_id`.
- `GET /health` — lightweight readiness response; do not load large ML models on every request.
- `POST /api/v1/enrollments` — multipart `audio` plus `rider_id`; create or replace an in-memory KYC baseline embedding. `GET /api/v1/enrollments/{rider_id}` reports whether the baseline exists. Server restart clears demo enrollments.
- `GET /api/v1/shifts/{rider_id}/{shift_id}` — return that rider's in-memory shift timeline. `call_label` must identify `Call #1` through `Call #4`; Call #1 establishes the shift comparison baseline. Calls arriving earlier stay pending and are resolved when Call #1 arrives.
- Treat this contract as provisional until mobile and backend owners confirm it. Any permitted step-up challenge must be handled through the approved in-app workflow, not by asking for a customer PIN/OTP during the call.
- Layer 4 settings: `REPLAY_FLATNESS_MAX`, `REPLAY_ROLLOFF_MAX_HZ`, and comma-separated `DELIVERY_KEYWORDS`; replay features are heuristic telemetry, not proof of liveness.

## Integration plan for three laptops

- Split work by interfaces after Phase 0: (A) backend/API and audio processing, (B) mobile capture and upload, (C) UI/demo flow and documentation. If responsibilities differ, record owners here.
- Keep the API contract, shared field names, environment variable names, and response schema stable; coordinate changes by updating this file before parallel edits.
- Each contributor records branch/commit identifier, changed paths, setup requirements, validation, and known issues in the work log.
- Integrate in dependency order: API contract and backend skeleton, mobile request flow, processing layers, then dashboard/demo polish. Resolve environment/config conflicts before merging feature code.
- After combining branches, use the work logs to map overlapping files and reconcile changes; retain contributor attribution and note resolved conflicts here.

## Decisions and assumptions

- **2026-10-17:** This is a plan only; implementation has not started. Repository inspection found no existing project files, so the plan assumes the stack and feature scope in the project brief.
- **2026-10-17:** Phase 0 inspection found only `PROJECT_LOG.md`; there is no existing Expo app, Python backend, dependency manifest, or Git repository in this directory. Python 3.13.12, Node 22.22.1, and npm 10.9.4 are available.
- **2026-10-17:** Global Python currently has FastAPI 0.116.1 and Groq 1.0.0 installed; Resemblyzer, faster-whisper, and librosa are missing. Use a project virtual environment rather than relying on these global packages.
- **2026-10-17:** Created a Python 3.13 project environment and dependency manifests. Initial Windows install showed Resemblyzer 0.1.4 attempts to compile source-only `webrtcvad`; use `webrtcvad-wheels` and install Resemblyzer with `--no-deps` (runtime import is available, though old package metadata makes `pip check` report missing distributions). Python 3.13 also requires NumPy 2.x for prebuilt wheels here. [webrtcvad-wheels on PyPI](https://pypi.org/project/webrtcvad-wheels/) [Resemblyzer Windows dependency issue](https://github.com/resemble-ai/Resemblyzer/issues/99)
- **2026-10-17:** Pin NumPy 2.x and apply `np.bool = bool` through `patch_numpy_bool()` only after SciPy/Resemblyzer imports. Applying the alias before SciPy initialization breaks NumPy masked arrays. A core import check and silent-audio WebRTC VAD trim both passed after this ordering fix.
- **2026-10-17:** Resolved shared dependency versions in `requirements.lock.txt` for cross-laptop consistency. Installed versions include NumPy 2.3.5, FastAPI 0.143.3, Groq 1.7.0, faster-whisper 1.2.1, librosa 0.11.0, Resemblyzer 0.1.4, and PyTorch 2.14.1.
- **2026-10-17:** Added `.env.example`; no API key is present. The Groq key must be created by the owner and stored in an untracked `.env` locally.
- **2026-10-17:** Proposed API contract added above to enable parallel work; it remains provisional pending contributor alignment. Prefer WAV/mono/16 kHz to reduce decode and resampling ambiguity.
- **2026-10-17:** Groq's current speech-to-text docs list `whisper-large-v3-turbo`; this is the planned cloud model. [Groq speech-to-text docs](https://console.groq.com/docs/speech-to-text)
- **2026-10-17:** Expo's tunnel and backend reachability are separate concerns. A public Expo QR code alone does not provide a URL for FastAPI.
- **2026-10-17:** Keep demo shift state in memory unless an existing persistence layer is discovered; this reduces initial setup and makes reset behavior explicit.
- **Pending:** Other laptop owners confirm the provisional API contract, upload format, enrollment flow, response schema, and demo tunnel provider.
- **Pending:** Set/calibrate cosine, trust, and replay thresholds using samples; do not invent fixed production thresholds in advance.
- **2026-10-18:** Initialized the local Git repository on branch `main` to prepare the shared project for three-laptop integration. No commit or remote is configured yet; do not invent the shared hosting URL. Root/mobile ignore rules exclude `.env`, virtual environments, and `node_modules`.
- **2026-10-18 policy update:** User clarified that delivery partners must not ask customers for PIN/OTP values on calls. This supersedes the initial project-brief plan to verify a spoken PIN. Removed the call-time PIN field/check and kept customer PIN/OTP handling out of the voice verification flow.

## Work log

### 2026-10-18 — Integrate account-sharing signals

- **Request:** Combine the three project parts to detect possible account handoff using account-holder location, IP, device, slider behavior, and voice.
- **Changed:** Made `Hack_forge/mobile` the combined app. Ported Stage 1 live/mock login screens and the slider screen into `mobile/src/integration`; added Overview/Login/Slider/Voice tabs sharing one rider ID. Added a FastAPI account-session endpoint backed by local SQLite to compare live IP/device/location with the rider's prior session. Added local per-rider slider profile persistence. Mock telemetry does not update the live baseline. Updated mobile/backend setup docs and the demo runbook.
- **Decision:** A single signal change is review evidence, not proof of account sharing. Voice enrollment and shift records remain in memory; account context persists in SQLite, and slider calibration persists on the phone.
- **Limitations:** The account-session endpoint is unauthenticated demo code; restrict it to a trusted network. No retention or baseline reset UI is included; deleting `data/account_sessions.sqlite3` resets account-context history. Slider and voice thresholds have not been validated against representative account handoffs.
- **Validation:** Expo SDK 57 docs checked for location and sensor packages. Dependency installation was attempted but the environment has networking disabled. No tests or device run performed.

### 2026-10-18 — Shape the account-sharing judge demo

- **Request:** Replace the stitched-together screens with a coherent demo narrative and unify their visual theme.
- **Changed:** Reworked the mobile overview into a guided three-signal sequence: establish sign-in context, calibrate the account-holder swipe pattern, then enroll and compare voice. Added clear step navigation, per-signal progress cards, an explainable session state, and a judge-facing handoff walkthrough. Standardized the app shell and voice check on the existing SOC dark palette used by Stage 1; aligned the slider background with it and removed identity-proof wording from its visible result labels. Expanded the demo runbook with the presentation sequence.
- **Validation:** TypeScript check passed. No phone visual review or end-to-end device run performed.

### 2026-10-17 — Initial plan

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added this plan and handoff log. No application code or environment was changed.
- **Basis:** User-provided requirements for Python audio processing, hybrid Whisper, Expo capture, four validation layers, and demo UI.
- **Validation:** Inspected repository root; it contained no project files at planning time.
- **Next:** Phase 0 repository/interface baseline, then confirm the request/response contract before parallel implementation.

### 2026-10-17 — Phase 0 inspection

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Recorded the actual repository/runtime inventory and added a provisional API contract to this file. No application code or dependencies were changed.
- **Findings:** Repository has no app/backend source, manifests, or Git metadata. Python 3.13.12, Node 22.22.1, npm 10.9.4 are present. Global Python includes FastAPI 0.116.1 and Groq 1.0.0; missing Resemblyzer, faster-whisper, and librosa.
- **Validation:** Read-only directory, runtime, and package inventory; no tests run.
- **Next:** Have the other laptop owners confirm/adjust the provisional API contract; environment setup has since been completed below.

### 2026-10-17 — Phase 1 environment setup

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `.python-version`, `.gitignore`, `requirements.txt`, `requirements.lock.txt`, `requirements-resemblyzer.txt`, `.env.example`, `backend/README.md`, `backend/app/__init__.py`, and `backend/app/audio_compat.py`. Created local ignored `.venv` and `.uv-cache` directories.
- **Behavior:** Project uses Python 3.13, locked shared dependencies, Groq model `whisper-large-v3-turbo`, local model defaults `base`/`int8`, and a delayed NumPy alias patch. Resemblyzer's Windows install workaround is documented.
- **Validation:** Installed packages in `.venv`; imported Resemblyzer, faster-whisper, Groq, FastAPI, and librosa; confirmed `np.bool is bool` after applying the patch; ran Resemblyzer WebRTC VAD silence trimming on a 2-second silent signal (returned 0 speech samples). `uv pip check` still reports the known Resemblyzer metadata gaps for `webrtcvad` and obsolete `typing`; do not fix by compiling source `webrtcvad` or installing the stale `typing` shim.
- **Limitations:** At initial environment setup, no Groq credential was provided. The key was configured later and validated as recorded below. Expo Go installation and mobile/backend connectivity require the physical Android phone and a configured backend tunnel. No Expo project exists yet.
- **Next:** Configure Groq credentials and implement the FastAPI upload route.

### 2026-10-17 — Hybrid ASR adapter

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `backend/app/transcription.py` and documented its behavior in `backend/README.md`.
- **Behavior:** Groq is primary when `GROQ_API_KEY` exists; any cloud/API failure or missing key selects a lazy CPU `faster-whisper` `base`/`int8` model. Response includes provider and fallback metadata. Logs avoid request payloads and exception text to reduce exposure of private audio or credentials.
- **Validation:** Imported the adapter in the project virtual environment. Did not call either transcription provider because no test recording or Groq key is configured; no model weights were downloaded.
- **Next:** Wire this adapter into the FastAPI upload route.

### 2026-10-17 — Groq credential setup

- **Author/laptop:** Codex / current project laptop, with the user creating and entering their own credential.
- **Changed:** Created local `.env` from `.env.example` with a blank `GROQ_API_KEY` field, opened it for the user, and the user entered the key locally. The actual key is not recorded in this log or chat.
- **Validation:** Sent an authenticated Groq models-list request; it succeeded. The key value was not printed.
- **Security:** `.env` is covered by `.gitignore`; this directory is not yet initialized as a Git repository.
- **Next:** Cloud credentials are ready for the transcription adapter. Local Whisper model weights will download on first offline transcription.

### 2026-10-17 — FastAPI upload route

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `backend/app/main.py` and updated `backend/README.md` with API/run instructions.
- **Behavior:** Added lightweight `GET /health` and multipart `POST /api/v1/voice-check` accepting `audio`, `rider_id`, `call_label`, `shift_id`, and `expected_pin`. Upload size is capped at 25 MB. The route invokes hybrid transcription and returns transcript/provider plus explicit `pending` layer states and null metrics rather than fabricated biometric scores.
- **Validation:** Not run in this step. The user requested implementation progress, not a test run.
- **Limitations:** Audio cleanup, enrollment/KYC matching, shift comparison, liveness, and PIN/context verdict are still pending. API contract remains provisional pending the other laptop owners' alignment.
- **Next:** Implement audio decoding, 85–3400 Hz bandpass and VAD/noise metrics; then connect the VAD output to Resemblyzer.

### 2026-10-17 — Expo audio format alignment

- **Author/laptop:** Codex / current project laptop, based on user clarification.
- **Decision:** Expo's mobile high-quality recorder preset outputs `.m4a` (AAC in MPEG-4); web uses WebM. Accept these as uploaded and decode/resample on the backend to mono 16 kHz for Layer 1. Groq's speech-to-text endpoint supports M4A uploads.
- **Impact:** Updated the provisional API contract; current upload route already accepts `audio/*` and preserves the uploaded filename for the transcription provider.
- **Source:** [Expo Audio recording presets](https://docs.expo.dev/versions/latest/sdk/audio/) and [Groq speech-to-text formats](https://console.groq.com/docs/speech-to-text).
- **Next:** Implement the Layer 1 decoder against M4A, WebM, and WAV inputs.

### 2026-10-18 — Layer 1 audio cleanup

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `backend/app/audio_pipeline.py`; wired it into `backend/app/main.py`; declared PyAV and SoundFile as direct dependencies; updated `requirements.lock.txt`, `backend/README.md`, and the API contract above.
- **Behavior:** Decodes the first audio stream with PyAV (including M4A/WebM/WAV), resamples to mono 16 kHz, applies a fourth-order 85–3400 Hz Butterworth bandpass, runs Resemblyzer's WebRTC VAD trimmer after the delayed NumPy alias patch, reports VAD-trimmed duration percentage, and encodes speech as PCM WAV for hybrid transcription. No-speech audio skips transcription and reports the audio layer as failed.
- **Metric definition:** `vad_noise_reduction_pct` is the fraction of decoded sample duration removed by VAD; it is not an SNR or security score.
- **Dependency note:** Lock regeneration hit a transient PyPI DNS failure. Existing lock already pins `av==19.0.1` and `soundfile==0.14.0`, which meet the newly declared ranges; dependency provenance comments were updated manually.
- **Validation:** No test or runtime request was run in this step.
- **Next:** Implement Layer 2 KYC enrollment embeddings and cosine comparison using the cleaned samples.

### 2026-10-18 — Layer 2 KYC speaker matching

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `backend/app/speaker.py`; added enrollment create/status endpoints and KYC matching to `backend/app/main.py`; added provisional thresholds to `.env.example`; updated `backend/README.md` and the API contract above.
- **Behavior:** Enrollment and voice checks encode cleaned speech into Resemblyzer's 256-D d-vector, normalize it, and compare with cosine similarity. Enrollment replaces the rider's current baseline in an in-memory table; no embedding is exposed in the API response. Voice checks now return the KYC similarity and mark the layer passed, warn (step-up), or alert. Similarity bands default to 0.75 and 0.65 but are configurable and explicitly provisional pending calibration. Other layers keep the overall verdict pending.
- **Limitations:** Baselines clear when the backend restarts. The first enrollment/comparison loads Resemblyzer weights lazily. One enrollment sample is used per rider; repeated enrollment replaces it rather than averaging samples.
- **Validation:** No enrollment request or model inference was run in this step; model weights may need downloading on first use.
- **Next:** Implement Layer 3 shift-scoped Call #1 embedding storage and pairwise similarity checks.

### 2026-10-18 — Layer 3 shift consistency

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `backend/app/shift_timeline.py`; updated `backend/app/speaker.py` to expose reusable embedding and comparison methods; wired shift tracking and `GET /api/v1/shifts/{rider_id}/{shift_id}` into `backend/app/main.py`; updated `backend/README.md` and this contract/log.
- **Behavior:** Track normalized 256-D vectors privately in an in-memory timeline keyed by rider and shift. A valid `Call #1` sets the shift-start baseline; each later call is compared to it using cosine similarity and the provisional pass/step-up/alert bands. Calls received before Call #1 are backfilled when the baseline arrives. Voice-check responses include shift similarity and a layer result; timeline responses expose labels, slots, scores, statuses, and timestamps, never embeddings.
- **Limitations:** Timeline state clears on server restart. Slot labels outside Call #1–#4 leave the shift layer pending. Similarity thresholds remain provisional and share the KYC threshold configuration. The endpoint records submissions; it does not enforce chronological order or deduplicate repeated slot submissions.
- **Validation:** No shift request or model inference was run in this step, per the milestone workflow.
- **Next:** Implement Layer 4 replay indicators, delivery/PIN context validation, and final verdict aggregation.

### 2026-10-18 — Layer 4 liveness/context and verdict

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Added `backend/app/liveness.py`; updated `backend/app/main.py` response fields, liveness integration, and verdict aggregation; added replay/context settings to `.env.example`; updated `backend/README.md` and the API contract above.
- **Behavior:** Compute mean spectral flatness and 85% spectral rolloff on VAD-cleaned audio. Raise a provisional replay-risk warning only when both configured metric thresholds trigger. Check the transcript for one configured delivery keyword and the expected PIN represented as digits or English digit words. Aggregate layer states with alert/failed first, then pending, then warning (`step_up`), otherwise verified. A no-speech sample returns alert. `voice_trust_score` is the lower of available KYC and shift cosine similarities on a 0–100 scale and remains null if either is unavailable.
- **Limitations/decisions:** Spectral features are weak replay heuristics, not validated liveness detection; a clean result does not prove a live speaker. Replay thresholds and keyword list are configurable but uncalibrated. Transcript PIN matching supports English digit words and digit strings only; expected PIN is client-supplied for this demo. The demo trust score is a transparent minimum of two cosine scores, not a calibrated probability. Liveness analysis failure returns HTTP 503.
- **Validation:** No test, audio sample analysis, or model inference was run in this milestone.
- **Next:** Confirm this API schema with the other laptops, then start mobile capture/upload against the agreed backend URL and surface per-layer metrics in the demo UI.

### 2026-10-18 — Remove call-time PIN validation

- **Author/laptop:** Codex / current project laptop, based on user policy clarification.
- **Changed:** Removed `expected_pin` from `POST /api/v1/voice-check`, removed PIN transcript matching and `pin_matched` response telemetry from `backend/app/main.py` and `backend/app/liveness.py`, removed OTP/PIN from default delivery keywords, and updated `.env.example`, `backend/README.md`, and the current project/API plan above.
- **Decision:** Riders must not solicit customer PIN/OTP values over calls. Any permitted step-up challenge belongs in an approved in-app flow, outside this audio call check. Earlier Layer 4 work-log text describes the superseded implementation and is retained as history; this entry and the current API contract describe the active behavior.
- **Validation:** No tests or audio samples were run for this policy update.

### 2026-10-18 — Mobile capture and voice-check client

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Created the Expo app under `mobile/` (`App.tsx`, `app.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `index.ts`, `AGENTS.md`, and template assets); added `mobile/.env.example` and `mobile/README.md`; initialized the app from Expo's blank TypeScript template, removed its nested `.git` metadata for clean integration into the shared repository, and pinned SDK 57/Expo Audio dependencies for the current Expo Go workflow.
- **Behavior:** Requests microphone permission on startup, configures foreground recording, supports four demo call slots, records for four seconds and automatically stops, then sends M4A/AAC multipart data to the backend. Adds a four-second voice enrollment action, since calls need an enrolled KYC baseline. Call requests send `audio`, `rider_id`, `call_label`, and `shift_id`; there is no PIN/OTP field. Displays backend verdict, trust score, KYC/shift similarities, VAD reduction, replay/context results, transcript/provider, and per-layer explanations.
- **Configuration:** Set `EXPO_PUBLIC_API_BASE_URL` in `mobile/.env` to the FastAPI origin reachable from the phone. Expo's tunnel is separate from the backend tunnel. Never place `GROQ_API_KEY` in the mobile environment.
- **Decision:** Background recording remains disabled; the core call sample records in foreground only. The demo shift ID and rider ID are currently screen defaults; rider ID is editable. Backend shift timeline and enrollment remain in-memory.
- **Validation:** Confirmed by [Expo project setup docs](https://docs.expo.dev/get-started/create-a-project/) that SDK 57 is the Expo Go template during the SDK 58 transition, and by the [SDK 57 Audio docs](https://docs.expo.dev/versions/v57.0.0/sdk/audio/) that `expo-audio` is included in Expo Go and the high-quality Android preset is M4A/AAC. `npm ci --no-audit --no-fund` completed successfully and added the 482 locked packages. No lint/typecheck, app launch, device recording, or API request was run in this milestone.
- **Limitations:** Phone-to-backend tunnel and physical Android permissions have not been exercised. The UI uses a demo fixed shift ID. A four-second enrollment sample may be short for production KYC; use a longer controlled enrollment flow before real deployment.
- **Next:** Connect a phone and backend URL and rehearse enrollment, voice-check upload, and the judge demo flow.

### 2026-10-18 — Demo dashboard polish and judge runbook

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Updated `mobile/App.tsx` to show spectral flatness and high-frequency rolloff, color-code per-layer states, disable ID/slot changes during capture/upload, and derive the demo shift ID from the current date. Added `DEMO_RUNBOOK.md` with setup, normal and changed-speaker narratives, fallback, and reset instructions. Updated Phase 4 plan above.
- **Behavior:** The runbook uses server restart as the explicit reset for in-memory enrollment/shift state. The fallback drill uses an invalid process-only Groq key or a LAN-only offline setup; it warns that cutting Wi-Fi breaks the phone-to-backend route when the phone depends on a laptop tunnel. Demo expectations are framed around provisional signals and sample-dependent thresholds.
- **Validation:** No API test, lint/typecheck, app launch, or physical-phone/tunnel rehearsal was run. The mobile dependency install completed with `npm ci` and 482 packages from the lockfile.
- **Limitations:** A teammate's voice on Call #4 is not guaranteed to cross the provisional threshold; record and calibrate representative same-speaker and different-speaker samples. The physical-device path still needs the project owner to set `mobile/.env` and run the rehearsal.
- **Next:** Configure the actual backend tunnel URL and complete the phone rehearsal; adjust thresholds only after reviewing collected demo samples.

### 2026-10-18 — Local Git integration baseline

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Initialized `.git/` with default branch `main`; updated this project log.
- **Behavior:** Working tree is now trackable for commits and branches. `.env`, `mobile/.env`, `.venv`, and `mobile/node_modules` are ignored; no remote or commit was created.
- **Validation:** Read-only `git status` and `git check-ignore` confirmed source files are visible and the listed secrets/generated dependencies are ignored.
- **Next:** Connect the agreed shared remote when its URL is available; assign laptop-specific branches and merge only after each owner records their changes in this log.

### 2026-10-18 — Expo asset version mismatch diagnosis

- **Author/laptop:** Codex / current project laptop.
- **Issue:** Android Metro bundling fails because `expo-asset@58.0.16` imports `expo/internal/bundle-origin`, which is absent from the installed `expo@57.0.30` package. Expo SDK 57's bundled dependency is `expo-asset@57.0.20`.
- **Changed:** Added the SDK-matched `expo-asset@~57.0.20` direct dependency in `mobile/package.json` so npm resolves the compatible SDK 57 package.
- **Validation/limitation:** `npx expo install --check` reported no bundled-map mismatch, but the active install had Expo Asset 58. Network is disabled in this execution environment, so npm could not refresh `mobile/package-lock.json` or `node_modules`; the user's local `npm install` from `mobile/` is required to complete this correction. No app tests were run.
- **Next:** Run `npm install` in `mobile/`, then restart Metro with `npx expo start --lan -c`.

### 2026-10-18 — Mobile multipart upload compatibility fix

- **Author/laptop:** Codex / current project laptop.
- **Issue:** Android phone reached `GET /health`, but voice upload failed with `Unsupported FormDataPart implementation` while React Native serialized the URI-based file part.
- **Changed:** Updated `mobile/App.tsx` to use Expo FileSystem's SDK 57 legacy native multipart uploader, preserving the `audio` file field and `rider_id`, `shift_id`, and `call_label` metadata. Response JSON parsing now reads the native upload response body and reports HTTP errors from FastAPI.
- **Decision:** Use the Expo SDK's native upload API rather than passing a `{ uri, name, type }` object to React Native's generic `FormData` implementation.
- **Validation:** Checked the installed Expo FileSystem type declarations and official SDK 57 documentation for `uploadAsync` and multipart metadata. No device upload or tests have been run yet; reload Expo and try enrollment before a voice check.

### 2026-10-18 — Enrollment 503 diagnostics

- **Author/laptop:** Codex / current project laptop.
- **Issue:** Phone reaches FastAPI and multipart enrollment is accepted, but enrollment returns HTTP 503 with the generic detail `Speaker enrollment is unavailable`.
- **Changed:** Added `logger.exception` in the enrollment exception handler in `backend/app/main.py`, so the backend terminal will show the underlying Resemblyzer/model/dependency traceback while the API continues returning a generic client-safe message.
- **Validation:** No backend/device retry run from this environment. Restart FastAPI and submit enrollment once to capture the traceback; inspect/redact secrets before sharing logs.

### 2026-10-18 — NumPy boolean alias correction from enrollment traceback

- **Author/laptop:** Codex / current project laptop.
- **Evidence:** The enrollment traceback showed librosa's Numba gufunc compilation receiving `dtype=Function(bool)` and failing in `librosa.core.audio`, after the compatibility patch had assigned Python's built-in `bool` to `np.bool`.
- **Changed:** Updated `backend/app/audio_compat.py` to map the removed alias to `np.bool_`, and clarified the rule in `backend/README.md`. Resemblyzer's legacy WebRTC VAD still gets a NumPy boolean dtype, while librosa/Numba no longer sees Python's built-in bool as its dtype.
- **Validation:** Reviewed the traceback and call ordering; did not run tests or the phone flow. Restart FastAPI and retry the enrollment to confirm the fix on this machine.

### 2026-10-18 — Speaker verdict clarity and longer captures

- **Author/laptop:** Codex / current project laptop.
- **Changed:** Updated the mobile result card to show a direct rider voice match verdict (`SAME SPEAKER LIKELY`, `UNCERTAIN · STEP-UP`, `VOICE MISMATCH SUSPECTED`, or `NOT COMPARED`) separately from the aggregate verdict. Enrollment failures now use an enrollment-specific alert title. Increased enrollment capture to 10 seconds and call capture to 8 seconds; updated mobile guidance and the demo runbook.
- **Decision:** Keep the direct voice assessment distinct from the overall verdict because replay/context and shift layers can change the aggregate result. Use qualified labels rather than a definitive same/different identity claim.
- **Accuracy note:** Longer clean speech samples may stabilize embeddings but do not establish real-world accuracy. Thresholds remain provisional and need representative same-speaker/different-speaker phone recordings for calibration.
- **Validation:** No lint/typecheck, tests, or phone capture run. Restart Expo with cache clear before exercising the new UI.

### 2026-10-18 — Conservative interim speaker thresholds

- **Author/laptop:** Codex / current project laptop.
- **Issue:** User reports a different speaker is labeled as a likely match under the current Resemblyzer cosine threshold.
- **Changed:** Raised default `KYC_MATCH_THRESHOLD` from `0.75` to `0.90` and `KYC_STEP_UP_THRESHOLD` from `0.65` to `0.80` in `backend/app/speaker.py` and `.env.example`; clarified the tradeoff in `backend/README.md`.
- **Decision:** Use stricter interim thresholds to reduce false accepts, accepting that false rejects may increase. These values are not calibrated or accuracy claims. Existing `.env` had no KYC threshold overrides when checked, so code defaults should apply after backend restart.
- **Validation:** No phone samples/tests run. Need compare same-speaker and different-speaker KYC similarity distributions on the actual device and tune from those measurements.

### 2026-10-18 — Multi-sample enrollment and trust-score availability

- **Author/laptop:** Codex / current project laptop.
- **Issue:** User reports phrase-sensitive speaker matching and missing voice-trust/shift scores.
- **Changed:** Enrollment can now reset a profile or append a same-rider sample (`append=true`); the profile averages up to five normalized embeddings. Added a mobile **Add Varied Voice Sample** action and sample count status. Voice trust now uses KYC similarity alone until shift similarity is available, then uses the lower of KYC and shift scores; API reports `voice_trust_basis`. The mobile UI labels the KYC-only trust score and prompts the user to run Call #1 when shift similarity is unavailable. Updated backend/mobile docs and demo runbook.
- **Decision:** Multiple varied enrollment utterances may reduce dependence on one phrase; this still needs device-sample validation. Shift similarity remains null until Call #1 for the current rider/shift, because fabricating a score would mislead. Backend restart clears KYC samples and shift timeline.
- **Validation:** No tests, lint/typecheck, or device flow run. Restart backend and Expo, enroll one clean sample plus two varied samples, then run Call #1 followed by later slots.

### 2026-10-18 — Separate shift thresholds from KYC thresholds

- **Author/laptop:** Codex / current project laptop.
- **Evidence:** User screenshot shows same-shift cosine similarity `0.861` classified as warn because KYC and shift shared the `0.90` pass threshold. It also shows a separate liveness/context warning; that heuristic is independent of speaker identity.
- **Changed:** Decoupled shift thresholds from KYC. Added `SHIFT_MATCH_THRESHOLD=0.85` and `SHIFT_STEP_UP_THRESHOLD=0.75` defaults in `backend/app/main.py` and `.env.example`, plus range validation. Updated the backend docs to mark the shift threshold as a provisional adjustment based on one reported score.
- **Expected:** A shift score of `0.861` will now pass the shift-consistency layer. KYC still uses its stricter `0.90/0.80` bands; acoustic replay/context can still independently result in an overall step-up.
- **Validation:** No tests or phone retry run. Restart FastAPI to apply the new thresholds.

### 2026-10-18 — Guided five-clip enrollment with Call Customer preserved

- **Author/laptop:** Codex / current project laptop.
- **Request/decision:** Replace manual incremental enrollment with one guided capture of five separate voice clips, then retain the existing **Call Customer** action so several speakers can be tried against that reference profile.
- **Changed:** Added `POST /api/v1/enrollments/batch-samples`; it accepts each M4A clip with `rider_id`, `batch_id`, and `sample_index`, extracts an embedding per clip, and saves the five embeddings as one profile when all indices arrive. Added `SpeakerVerifier.enroll_embeddings()` to validate and store a group of vectors. Updated mobile capture UI to guide five 10-second clips and upload them one by one; preserved the single 8-second Call Customer voice-check endpoint and UI. Updated backend/mobile README and demo runbook with the contract and demo sequence.
- **Behavior:** Each new Call Customer sample is compared by the existing KYC matcher to the centroid made from all five enrolled embeddings. Call Customer does not overwrite the baseline. A new five-clip enrollment session replaces it.
- **Validation:** No tests, typecheck, or device recording run. Review the code and API schema, restart FastAPI and Expo, enroll five clips, then compare the rider and teammate through Call Customer.
- **Integration note:** Pull the API route, speaker service method, mobile flow, and docs together. Backend restarts clear both completed enrollment and in-progress batches; every laptop must run its own enrollment session.

### 2026-10-18 — Replace voice stack with ECAPA speaker verification; remove ASR

- **Author/laptop:** Codex / current project laptop.
- **Issue/request:** User reports the current voice-recognition results are inaccurate and requested a full architecture change, no Whisper, and a stronger speaker-recognition model.
- **Model decision:** Replace Resemblyzer with SpeechBrain `speechbrain/spkrec-ecapa-voxceleb` (ECAPA-TDNN), an open-source pretrained speaker-verification model. SpeechBrain documents cosine verification and a default threshold of `0.25`; the project uses `0.25` as provisional pass and `0.15` for step-up. These thresholds are not validated for our Android phone or rider population. SpeechBrain reports `0.80%` EER on VoxCeleb1 test-clean; this benchmark does not predict performance on our app's phone/noise conditions. References: [SpeechBrain ECAPA model card](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb), [speaker verification API](https://speechbrain.readthedocs.io/en/v1.1.2/API/speechbrain.inference.speaker.html), [SpeechBrain performance results](https://github.com/speechbrain/speechbrain/blob/develop/PERFORMANCE.md), [ECAPA-TDNN paper](https://arxiv.org/abs/2005.07143).
- **Changed:** `backend/app/speaker.py` now loads ECAPA lazily on CPU, caches weights under `models/speechbrain-ecapa`, stores the five enrollment embeddings as separate templates, compares each Call Customer embedding to every template, and returns the median plus individual scores/spread. Updated minimum usable speech to two seconds on enrollment and match requests. `backend/app/audio_pipeline.py` now uses direct WebRTC VAD frame processing and preserves original speech bandwidth (removed the old 85–3400 Hz bandpass and Resemblyzer VAD dependency). `backend/app/shift_timeline.py` accepts model-dependent embedding dimensions rather than requiring 256-D.
- **Removed from active API/UI/dependencies:** Groq/faster-whisper transcription, transcripts, delivery-keyword checks, spectral replay heuristics, Resemblyzer, librosa, and the NumPy compatibility patch. The score is now displayed as cosine similarity, not multiplied by 100 and mislabeled as a trust percentage. No ASR or context rule gates a speaker match.
- **Changed paths:** `backend/app/speaker.py`, `backend/app/audio_pipeline.py`, `backend/app/main.py`, `backend/app/shift_timeline.py`, `mobile/App.tsx`, `requirements.txt`, `requirements.lock.txt`, `.env.example`, backend/mobile READMEs, `DEMO_RUNBOOK.md`; deleted `backend/app/transcription.py`, `backend/app/liveness.py`, `backend/app/audio_compat.py`, and `requirements-resemblyzer.txt`.
- **Dependency lock:** Regenerated `requirements.lock.txt` with `speechbrain==1.1.2`, `torch==2.11.0`, and matching `torchaudio==2.11.0`. The app downloads model weights on first inference; prime the model while online for offline use.
- **Validation/limitations:** Lock resolution and `.venv` sync succeeded. Loaded the ECAPA model on this Windows laptop and confirmed a synthetic 3-second waveform produces a normalized 192-D embedding. Backend `compileall` and mobile `tsc --noEmit` passed. `expo lint` could not run because ESLint is absent and the Expo CLI could not install it with network disabled. No Android/user recordings or same-speaker/impostor evaluation set have been run, so accuracy is not established; tune thresholds using held-out samples captured on the target phone before treating the verdict as meaningful.
- **Integration note:** All contributors must remove old Groq/Whisper/Resemblyzer setup assumptions and install from the updated lock. Backend restart clears all enrollment and shift state, so each laptop needs a new five-clip enrollment. Do not commit downloaded weights or local `.env` secrets.

### 2026-10-18 — Repository cleanup audit

- **Request:** Remove unwanted files after the voice-recognition architecture change.
- **Audit:** Confirmed obsolete implementation files (`backend/app/transcription.py`, `backend/app/liveness.py`, `backend/app/audio_compat.py`, and `requirements-resemblyzer.txt`) were already removed in the ECAPA migration. Searched active source and setup files for references to those modules and the former Groq/Whisper/Resemblyzer/librosa stack; no active references remain. Kept historical change notes in this log for integration context.
- **Changed:** Corrected `mobile/README.md` to point to the actual repository-root `models/speechbrain-ecapa` model cache.
- **Preserved:** `.env`, model cache, virtual environment, package installs, `.codex-remote-attachments`, Expo assets referenced by `mobile/app.json`, lockfiles, runbook, and project log. These are local state, user data, dependencies, used assets, or integration documentation; deleting them could disrupt the project or erase useful evidence.
- **Validation:** Inspected the repository file list, Expo asset references, git status, and active references to the retired stack. No tests run. No additional safe-to-delete project files were found.

### 2026-10-18 — Remove legacy transcription configuration

- **Request:** Remove all Whisper-related project setup after moving to ECAPA speaker verification.
- **Changed:** Removed the stale Groq API key and Groq/local transcription settings from the root `.env`; removed obsolete feature disclaimers from the current backend/mobile READMEs and demo runbook. No active code or dependency references remained to remove.
- **Documentation decision:** Kept earlier project-log entries that describe the superseded plan and migration, since this file is the requested cross-laptop history. Those entries are historical only; the current architecture at the top and the ECAPA migration entry are authoritative.
- **Validation:** Searched active backend/mobile code, dependency manifests, environment example, and current setup docs. No transcription implementation/configuration remains there. No tests run.

### 2026-10-18 — Show uncertainty for step-up verdicts

- **Request:** When the result card shows a step-up outcome, label the rider voice result as uncertain instead of same speaker likely.
- **Changed:** The mobile rider-match box now displays `UNCERTAIN · STEP-UP` whenever the overall API verdict is `step_up`, even if the individual KYC speaker layer passed. The explanation distinguishes a marginal speaker-layer warning from a step-up raised by another layer.
- **Validation:** `npx tsc --noEmit` passed. `npx expo lint` could not run because ESLint dependencies are absent and the environment has networking disabled; no device run.

### 2026-10-18 — Combine rider and restaurant mobile workflows

- **Request:** Put the rider account-integrity demo and restaurant pickup face verification into one Expo app, with a top-level switch between Rider and Restaurant.
- **Changed:** Added a shared Trust Operations header and Rider/Restaurant switch in `mobile/App.tsx`. The new `mobile/RestaurantPage.tsx` loads assigned partners and orders from the pickup API, enrolls partner faces, verifies an arriving partner against the selected order, and displays match/review outcomes. The existing pickup backend continues forwarding outcome metadata to the dashboard; image data and face templates are not sent there.
- **Theme and setup:** Reused the app's dark navy and blue styling, added the SDK 57 `expo-camera` dependency/config, and added `EXPO_PUBLIC_PICKUP_API_URL` alongside the rider API URL. Updated root/mobile run docs to start Expo once from `Hack_forge/mobile` and the two FastAPI services on ports 8000 and 8001.
- **Validation:** Mobile `tsc --noEmit` passed and `expo config --type public` resolved the camera plugin and both local API variables. Expo lint could not run because ESLint packages are unavailable offline. No device run or tests performed.
- **Repository boundary:** The combined mobile client is in `Hack_forge/mobile`; the pickup face backend and model files remain in the sibling `Hack_forge_2` project and must still be started separately.
