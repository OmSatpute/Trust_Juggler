# Rider account integrity demo

This Expo SDK 57 app contains two workflows in one install: **Rider** account-integrity checks and **Restaurant** pickup-counter face verification. Use the top switch to move between them. The screens use the same dark navy Trust Operations theme. The rider page uses the Hack_forge API; the restaurant page uses the face-recognition API in the sibling `Hack_forge_2` folder.

## Configure and run on a local network

1. Copy `.env.example` to `.env`. Set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN IPv4 address on port 8000 and `EXPO_PUBLIC_PICKUP_API_URL` to the same address on port 8001. Do not use `localhost` on the phone.
2. Start the account-integrity API from the repository root as described in `backend/README.md`, binding to `0.0.0.0:8000`.
3. Start the pickup face-verification API from `Hack_forge_2` as described in that project's README, binding to `0.0.0.0:8001`.
4. Keep the phone and computer on the same Wi-Fi. From this `mobile/` folder, run `npx expo start --lan` once and scan the QR code in Expo Go. Use the top buttons to switch between Rider and Restaurant.
5. If the phone cannot reach either backend, allow Python through the computer's firewall for the private network and confirm both devices are on the same LAN.

The Trust Operations dashboard is served by the account-integrity API at `http://<computer-lan-ip>:8000/dashboard`. It reads rider checks and pickup-counter face-verification events forwarded by the `Hack_forge_2` service. Keep both APIs and the phone on the trusted LAN.

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
