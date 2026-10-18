# Hack Forge · Rider Account Integrity Demo

A mobile demo and local operations dashboard for reviewing whether a rider account session resembles its account holder's established use. The project combines three independent signals:

- Sign-in context: public IP, device description, and foreground location.
- Swipe behavior: gesture timing, path, vertical drift, and device tilt.
- Voice: five-clip account-holder enrollment and ECAPA-TDNN speaker comparison.

The signals are review evidence, not proof of who used an account. Voice similarity and gesture thresholds are provisional demo heuristics. The backend has no authentication; run it on a trusted LAN only.

## Components

- `mobile/` — one Expo React Native app with Rider and Restaurant pages, switched from the top bar.
- `backend/` — FastAPI service for account context, gesture profiles, and voice checks.
- `dashboard/` — Responsive Trust Operations report served by FastAPI at `/dashboard`.
- `../Hack_forge_2/` — pickup-counter face verification app/service; it can forward order verification outcomes to this dashboard.
- `DEMO_RUNBOOK.md` — Setup and demo sequence.

## Run on a local network

1. Set up the Python environment using [backend/README.md](backend/README.md). Start the account-integrity API from this folder:

   ```powershell
   .venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```

2. Open the dashboard on the computer at [http://localhost:8000/dashboard](http://localhost:8000/dashboard).
3. Copy `mobile/.env.example` to `mobile/.env` and set both API URLs to the computer's LAN IPv4 address (account API port 8000, pickup API port 8001).
4. In a second terminal, run the Expo app:

   ```powershell
   cd mobile
   npm ci
   npx expo start --lan
   ```

5. Keep the phone and computer on the same Wi-Fi and scan Expo's QR code.

The single mobile app includes both workflows. For the Restaurant page, also start the face service from the sibling `Hack_forge_2` folder on port 8001 and set `TRUST_DASHBOARD_EVENT_URL=http://127.0.0.1:8000/api/v1/pickup-events` in `Hack_forge_2/backend/.env`. The dashboard receives only order/partner IDs, result category, threshold/similarity, model version, and explanation; it does not receive face images or embeddings. The face-verification backend and models still live in the sibling folder; the phone UI and Expo setup are consolidated under this repository's `mobile/` folder.

See [mobile/README.md](mobile/README.md) and [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) for details. Do not commit `.env` files, SQLite data, installed dependencies, model weights, or real voice recordings.
