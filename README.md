# rclone-hub

Mac-first, cross-platform local web UI for rclone remotes with multi-pane navigation and safe transfers.

## Structure

- `/backend`: FastAPI API + transfer engine + sqlite persistence.
- `/frontend`: React/Vite multi-pane UI.
- `/docs`: architecture and safety docs.

## Backend quickstart

```bash
cd /Users/andreas/code/rclone-hub/backend
python -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Frontend quickstart

```bash
cd /Users/andreas/code/rclone-hub/frontend
npm install
npm run dev
```

Then open `http://127.0.0.1:5173`.
