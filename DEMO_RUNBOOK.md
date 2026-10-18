# Rider Account Integrity Demo Runbook

The demo answers one question: **Does this session look consistent with the rider account holder's established use?** One custom dashboard compares three signals: sign-in context (IP, device, location), swipe behavior, and voice. The account holder establishes the baselines; a second person or device then runs the same checks under the same rider ID.

## Prepare the demo

1. Install backend dependencies and start FastAPI from the repository root:

   ```powershell
   .venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```

2. Copy `mobile/.env.example` to `mobile/.env`. Set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN IPv4 address, such as `http://192.168.1.25:8000`. A phone cannot use `localhost` to reach the computer.
3. Connect the phone and computer to the same Wi-Fi. From `mobile/`, run:

   ```powershell
   npx expo start --lan
   ```

4. Scan the QR code in Expo Go and grant microphone access. If the API does not respond, check the private-network firewall rule and confirm both devices share the same LAN.
5. Open `http://<computer-lan-ip>:8000/dashboard` in the laptop browser. It shares the backend with the mobile app and refreshes recorded checks every 2 seconds.

## Judge sequence

1. Enter a rider ID and capture sign-in context on the account holder's usual phone. This saves the first baseline. Explain that it records public IP, device description, and foreground location.
2. Calibrate three swipes with the account holder. The backend stores swipe timing, path, vertical drift, and device tilt under the same rider ID.
3. Enroll five voice clips from the account holder. Run an 8-second voice check to show a match against the enrollment.
4. Have a second person or device use the same rider ID. Capture sign-in context, check a swipe, and check voice. If the second device is unavailable, demonstrate with whichever signals can be changed in the room.
5. Read the combined assessment and its signal details. Explain that changes raise a review concern; they do not establish who used the account.
6. Use the Trust Operations dashboard to show alert/review totals, the activity feed, signal review volume, and the rider radar comparing latest checks with the prior check per signal.

## What persists

Account sessions and swipe profiles persist in `backend/data/account_sessions.sqlite3`; delete that file to reset them. Voice enrollment and shift comparisons are in memory and must be enrolled again after FastAPI restarts. Keep the backend and phone on a trusted LAN because the demo API has no authentication.

## Limits to state clearly

- A network, location, or device change may be legitimate, and public IP is not a person's identity.
- Gesture and voice thresholds are provisional demo heuristics, not calibrated production policy.
- Voice similarity is not a probability and does not prove liveness; replay or cloned voice attacks are not addressed.
- The demo does not request customer PINs or OTPs.
