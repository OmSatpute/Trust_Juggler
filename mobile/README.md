# Rider account integrity demo

This Expo SDK 57 app presents one account-sharing review workflow. It uses the project's existing voice-verification API and combines it with login-context comparison and a server-stored swipe baseline. The screen is built for this demo; it does not embed the original project screens.

## Configure and run on a local network

1. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN IPv4 address, for example `http://192.168.1.25:8000`. Do not use `localhost` on the phone.
2. Start FastAPI from the repository root as described in `backend/README.md`, binding to `0.0.0.0:8000`.
3. Keep the phone and computer on the same Wi-Fi. In `mobile/`, run `npx expo start --lan` and scan the QR code in Expo Go.
4. If the phone cannot reach the backend, allow Python through the computer's firewall for the private network and confirm that both devices are on the same LAN.

The companion Trust Operations dashboard is served by FastAPI at `http://<computer-lan-ip>:8000/dashboard`. It reads the same backend and refreshes its signal-check history automatically; open it on a laptop browser while using the phone demo. Keep both on the trusted LAN.

## Demo sequence

1. Choose a rider ID and tap **Capture / compare sign-in** on the usual phone. The first session establishes a context baseline; later sessions compare public IP, device description, and foreground GPS location against the most recent session.
2. Tap **Calibrate 3 swipes** and have the account holder swipe three times. The API stores gesture timing, path, drift, and phone tilt features for that rider.
3. Tap **Enroll voice · 5 clips** and record the account holder's five voice samples. Then use **Check voice · 8s** to compare a new speaker sample against that enrollment.
4. Run the same checks with a second person or device using the same rider ID. The top assessment summarizes independent changes and gives a review signal.

IP, device, location, swipe, and voice differences are evidence for account review, not proof of account sharing. A changed network or device can be legitimate. The demo does not request a customer PIN or OTP.

## Data and limits

- Account-session context and gesture profiles persist in `backend/data/account_sessions.sqlite3` across backend restarts. Delete that file to reset those baselines.
- Voice enrollment and shift comparisons remain in memory and must be recreated after a backend restart.
- Location is requested only in the foreground. Public IP lookup uses `api.ipify.org`; if that lookup fails, IP is shown as unavailable.
- Gesture and voice thresholds are demo heuristics. Voice similarity is not a probability, and the system does not prove liveness or identity.
- The backend currently has no authentication. Keep it on a trusted LAN for the demo.
