# Architecture

- Frontend: React + TypeScript + Vite.
- Backend: FastAPI + Pydantic + sqlite.
- Transfer engine: async queue worker with persisted job states.
- Integrations: shelling out to `rclone` CLI.

## Core safety controls

- Localhost binding by default.
- Strict verification after copy before source delete in move.
- Automatic fallback to local staging when direct remote transfer fails.
- Staging cap with queue wait behavior.
