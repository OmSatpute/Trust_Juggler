# Hack Forge · Rider Account Integrity Demo

A mobile demo and local operations dashboard for reviewing whether a rider account session resembles its account holder's established use. The project combines three independent signals:

- Sign-in context: public IP, device description, and foreground location.
- Swipe behavior: gesture timing, path, vertical drift, and device tilt.
- Voice: five-clip account-holder enrollment and ECAPA-TDNN speaker comparison.

The signals are review evidence, not proof of who used an account. Voice similarity and gesture thresholds are provisional demo heuristics. The backend has no authentication; run it on a trusted LAN only.

## Components

- `mobile/` — Expo React Native app for establishing a rider baseline and checking a new session.
- `backend/` — FastAPI service for account context, gesture profiles, and voice checks.
- `dashboard/` — Responsive Trust Operations report served by FastAPI at `/dashboard`.
- `DEMO_RUNBOOK.md` — Setup and demo sequence.

## Run on a local network

1. Set up the Python environment using [backend/README.md](backend/README.md). Start the API from this folder:

   ```powershell
   .venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```

2. Open the dashboard on the computer at [http://localhost:8000/dashboard](http://localhost:8000/dashboard).
3. Copy `mobile/.env.example` to `mobile/.env` and replace the sample IP with the computer's LAN IPv4 address.
4. In a second terminal, run the Expo app:

   ```powershell
   cd mobile
   npm ci
   npx expo start --lan
   ```

5. Keep the phone and computer on the same Wi-Fi and scan Expo's QR code.

See [mobile/README.md](mobile/README.md) and [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) for details. Do not commit `.env` files, SQLite data, installed dependencies, model weights, or real voice recordings.
