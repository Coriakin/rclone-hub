from __future__ import annotations

from pathlib import Path
import os
import tempfile


APP_DIR = Path.home() / ".rclone-hub"
DB_PATH = APP_DIR / "rclone_hub.db"
DEFAULT_STAGING_PATH = Path(tempfile.gettempdir()) / "rclone-hub-staging"

HOST = os.getenv("RCLONE_HUB_HOST", "127.0.0.1")
PORT = int(os.getenv("RCLONE_HUB_PORT", "8000"))
