# Backend

## Run

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade "pip>=23.2" "setuptools>=68" "wheel>=0.41"
python -m pip install -e '.[dev]'
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Verbose diagnostics

The backend now logs each rclone command execution with timing and stderr/stdout snippets.

```bash
export RCLONE_HUB_LOG_LEVEL=DEBUG
export RCLONE_HUB_RCLONE_TIMEOUT_SECONDS=300
export RCLONE_HUB_RCLONE_MAX_RETRIES=1
# optional extra rclone flags, for example:
export RCLONE_HUB_RCLONE_FLAGS="--retries=1 --low-level-retries=1"
```

## Test

```bash
cd backend
pytest
```
