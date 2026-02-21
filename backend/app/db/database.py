from __future__ import annotations

from pathlib import Path
import json
import sqlite3
from typing import Any

from app.config import APP_DIR, DB_PATH, DEFAULT_STAGING_PATH
from app.models.schemas import Job, JobStatus, Settings


class Database:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        self.db_path = db_path
        APP_DIR.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                  id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  payload TEXT NOT NULL
                )
                """
            )
            conn.commit()

        if not self.get_settings():
            self.set_settings(
                Settings(
                    staging_path=str(DEFAULT_STAGING_PATH),
                    staging_cap_bytes=20 * 1024 * 1024 * 1024,
                    concurrency=2,
                )
            )

    def get_settings(self) -> Settings | None:
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
        if not rows:
            return None
        as_dict = {row["key"]: json.loads(row["value"]) for row in rows}
        return Settings(**as_dict)

    def set_settings(self, settings: Settings) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM settings")
            for key, value in settings.model_dump().items():
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?)",
                    (key, json.dumps(value)),
                )
            conn.commit()

    def upsert_job(self, job: Job) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs(id, status, payload) VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload
                """,
                (job.id, job.status.value, job.model_dump_json()),
            )
            conn.commit()

    def list_jobs(self) -> list[Job]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM jobs ORDER BY rowid DESC").fetchall()
        return [Job.model_validate_json(row["payload"]) for row in rows]

    def get_job(self, job_id: str) -> Job | None:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        return Job.model_validate_json(row["payload"])

    def mark_running_jobs_interrupted(self) -> None:
        jobs = self.list_jobs()
        for job in jobs:
            if job.status == JobStatus.running:
                job.status = JobStatus.interrupted
                self.upsert_job(job)
