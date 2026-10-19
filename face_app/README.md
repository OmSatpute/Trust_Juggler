# Pickup Verify · Hack Forge Part 2

Restaurant counter demo: enroll a delivery partner's face, choose a demo order, and compare the arriving face only against the partner assigned to that order. The Expo app captures a photo; this project's FastAPI backend runs the YuNet detector and ArcFace model directly, then stores a 512-value template in a local SQLite database. You do not need to start a separate face-service process.

## Current demo contents

- Three sample delivery partners and three sample orders, each assigned to a different partner.
- In-app face enrollment and order-specific pickup verification.
- Explicit no-face, multiple-face, not-enrolled, and service-unavailable errors.
- Mismatch and uncertain cases are routed to staff review in the UI.
- The API uses a provisional cosine threshold (`0.45`). It is not calibrated and the UI labels scores as demo-only. Three group members are suitable for a walkthrough, not a meaningful accuracy evaluation.

## Run the local ArcFace backend

From this folder in PowerShell:

```powershell
py -3.13 -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
Copy-Item backend/.env.example backend/.env
& .\backend\scripts\download-models.ps1
```

The model downloader verifies both model files by size and SHA-256/SHA-384. I copied the weights into this workspace for the current local setup; the downloader skips them if they still pass verification. Model files are excluded from Git because ArcFace's weights are about 261 MB. Start the API:

```powershell
& .\backend\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

The API loads `backend/.env` on startup and loads both models when it starts. The SQLite file is created at `backend/data/pickup_verify.sqlite3` and is ignored by Git. Keep this backend running on the computer hosting the models.

## Run Expo Go

```powershell
npm install
npx expo install expo-camera
$env:EXPO_PUBLIC_API_URL = "http://192.168.1.20:8000"
npx expo start --tunnel
```

Set `EXPO_PUBLIC_API_URL` in the shell before starting Expo. Use `http://127.0.0.1:8000` when testing in a desktop browser, the computer's LAN IP (for example `http://192.168.1.20:8000`) on the same Wi-Fi, or a separately secured backend tunnel for remote phone access. Expo's tunnel does not expose the API. Android emulators can use `http://10.0.2.2:8000`.

The camera module is included in Expo Go for SDK 57. Model inference runs on the backend, not on the phone. [Expo SDK 57 camera docs](https://docs.expo.dev/versions/v57.0.0/sdk/camera/)

## Demo sequence

1. Start the Part 2 ArcFace backend, then Expo.
2. Enroll all three demo partners with one clear face capture each.
3. Open an order assigned to Partner 1 and verify that partner, then try Partners 2 and 3 against that same order.
4. A mismatch stays at the counter and prompts staff review. Repeat with each assigned order to demonstrate assignment-aware comparison.

## Important limits

- The order and partner lists are hard-coded demo data. There is no restaurant login, live POS/dispatch integration, or role-based access yet.
- The backend has no user authentication, authorization, rate limiting, or production privacy controls. Do not expose this demo API or face service publicly.
- Enrollment templates are biometric data. They are stored in a local SQLite file without encryption and have no deletion/retention workflow yet. Only use consenting participants for the demo; delete `backend/data/pickup_verify.sqlite3` to remove the demo profiles.
- The ArcFace service does not detect liveness or presentation attacks. A printed/displayed photo may be accepted. The similarity threshold is provisional, and a three-person demo cannot establish accuracy.
- The service and backend accept only one detected face per uploaded image; the backend does not persist original face photos.
