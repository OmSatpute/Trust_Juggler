# Rider Account Integrity Demo Runbook

The demo now shows rider account-integrity checks and restaurant pickup-counter face verification in one Trust Operations dashboard. Rider checks compare sign-in context, swipe behavior, and voice. Pickup checks compare the arriving face with the delivery partner assigned to an order. These are separate workflows; each dashboard event shows its source and result. Face matching is demo-only and is not liveness detection.

## Prepare the demo

1. Install backend dependencies and start FastAPI from the repository root:

   ```powershell
   .venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```

2. For pickup-counter face verification, open another PowerShell window in `E:\Projects\hack\Hack_forge_2`. Set up its backend per that folder's README, copy `backend/.env.example` to `backend/.env` if needed, and ensure it contains `TRUST_DASHBOARD_EVENT_URL=http://127.0.0.1:8000/api/v1/pickup-events`. Start that API on port 8001:

   ```powershell
   .\backend\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8001
   ```

3. Copy `mobile/.env.example` to `mobile/.env` in `Hack_forge`. Set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN IPv4 address on port 8000 and `EXPO_PUBLIC_PICKUP_API_URL` to that address on port 8001. A phone cannot use `localhost` to reach the computer.
4. Connect the phone and computer to the same Wi-Fi. Start the unified mobile app once from `Hack_forge/mobile`:

   ```powershell
   # Hack_forge/mobile — Rider and Restaurant pages
   npx expo start --lan
   ```

5. Scan the QR code in Expo Go. Use the top **Rider** and **Restaurant** buttons to switch workflows. Grant camera/microphone/location permissions as requested. If an API does not respond, check the private-network firewall rule and confirm phone and computer share the LAN.
6. Open `http://<computer-lan-ip>:8000/dashboard` in the laptop browser. It refreshes recorded checks every 2 seconds.

## Judge sequence

1. Enter a rider ID and capture sign-in context on the account holder's usual phone. This saves the first baseline. Explain that it records public IP, device description, and foreground location.
2. Calibrate three swipes with the account holder. The backend stores swipe timing, path, vertical drift, and device tilt under the same rider ID.
3. Enroll five voice clips from the account holder. Run an 8-second voice check to show a match against the enrollment.
4. Have a second person or device use the same rider ID. Capture sign-in context, check a swipe, and check voice. If the second device is unavailable, demonstrate with whichever signals can be changed in the room.
5. Read the combined assessment and its signal details. Explain that changes raise a review concern; they do not establish who used the account.
6. At the restaurant counter, enroll consenting demo partners in the pickup app, then verify an assigned partner for an order. The face service posts match, mismatch, no-face, and multiple-face outcomes to the dashboard.
7. Use the Trust Operations dashboard to show rider alert/review totals, pickup outcomes, the activity feed, signal review volume, and the radar comparing latest checks with prior checks per signal.

## What persists

Account sessions and swipe profiles persist in `backend/data/account_sessions.sqlite3`; delete that file to reset them. Voice enrollment and shift comparisons are in memory and must be enrolled again after FastAPI restarts. Keep the backend and phone on a trusted LAN because the demo API has no authentication.

Pickup verification events are added to the same dashboard database. The separate face service keeps face templates in its own local SQLite database; those templates and camera images are not forwarded to the dashboard. Use only consenting participants and remove `Hack_forge_2/backend/data/pickup_verify.sqlite3` when clearing demo face profiles.

## Limits to state clearly

- A network, location, or device change may be legitimate, and public IP is not a person's identity.
- Gesture and voice thresholds are provisional demo heuristics, not calibrated production policy.
- Voice similarity is not a probability and does not prove liveness; replay or cloned voice attacks are not addressed.
- The demo does not request customer PINs or OTPs.
