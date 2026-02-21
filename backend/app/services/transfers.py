from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import uuid
import traceback

from app.db.database import Database
from app.models.schemas import (
    DeleteRequest,
    FallbackMode,
    Job,
    JobItemResult,
    JobLog,
    JobOperation,
    JobStatus,
    Settings,
    TransferRequest,
)
from app.services.rclone import RcloneClient
from app.services.verify import verify_strict


@dataclass
class QueueItem:
    job_id: str


class TransferManager:
    def __init__(self, db: Database, client: RcloneClient) -> None:
        self.db = db
        self.client = client
        self.queue: asyncio.Queue[QueueItem] = asyncio.Queue()
        self.jobs: dict[str, Job] = {j.id: j for j in db.list_jobs()}
        self.active_tasks: dict[str, asyncio.Task[None]] = {}
        self.cancelled: set[str] = set()
        self.staging_in_use_bytes = 0
        self.worker_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self.worker_task is None:
            self.db.mark_running_jobs_interrupted()
            # Reload after DB recovery so in-memory job states match persisted status.
            self.jobs = {j.id: j for j in self.db.list_jobs()}
            self.worker_task = asyncio.create_task(self._worker())

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _log(self, job: Job, level: str, message: str) -> None:
        job.logs.append(JobLog(ts=self._now(), level=level, message=message))
        self.db.upsert_job(job)

    def _new_job(self, operation: JobOperation, sources: list[str], destination_dir: str | None, fallback: FallbackMode | None = None) -> Job:
        job = Job(
            id=str(uuid.uuid4()),
            operation=operation,
            status=JobStatus.queued,
            created_at=self._now(),
            sources=sources,
            destination_dir=destination_dir,
            fallback_mode=fallback,
        )
        self.jobs[job.id] = job
        self.db.upsert_job(job)
        return job

    def submit_transfer(self, req: TransferRequest) -> Job:
        job = self._new_job(req.operation, req.sources, req.destination_dir, req.fallback_mode)
        job.verify_mode = req.verify_mode
        self.db.upsert_job(job)
        self.queue.put_nowait(QueueItem(job_id=job.id))
        return job

    def submit_delete(self, req: DeleteRequest) -> Job:
        job = self._new_job(JobOperation.delete, req.sources, None)
        self.queue.put_nowait(QueueItem(job_id=job.id))
        return job

    def cancel(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        self.cancelled.add(job_id)
        if job.status == JobStatus.queued:
            job.status = JobStatus.cancelled
            job.completed_at = self._now()
            self.db.upsert_job(job)
        return job

    def list_jobs(self) -> list[Job]:
        return sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)

    def get_job(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    async def _worker(self) -> None:
        while True:
            queue_item = await self.queue.get()
            job = self.jobs.get(queue_item.job_id)
            if not job:
                self.queue.task_done()
                continue
            if job.id in self.cancelled:
                job.status = JobStatus.cancelled
                job.completed_at = self._now()
                self.db.upsert_job(job)
                self.queue.task_done()
                continue
            try:
                await self._run_job(job)
            except Exception as exc:
                job.status = JobStatus.failed
                job.completed_at = self._now()
                self._log(job, "error", f"job crashed unexpectedly: {exc}")
                self._log(job, "error", traceback.format_exc())
                self.db.upsert_job(job)
            finally:
                self.queue.task_done()

    async def _run_job(self, job: Job) -> None:
        settings = self.db.get_settings() or Settings(staging_path="/tmp/rclone-hub-staging")
        job.status = JobStatus.running
        job.started_at = self._now()
        self.db.upsert_job(job)

        if job.operation == JobOperation.delete:
            await self._run_delete(job)
        else:
            await self._run_transfer(job, settings)

    async def _run_delete(self, job: Job) -> None:
        failures = False
        for source in job.sources:
            if job.id in self.cancelled:
                job.status = JobStatus.cancelled
                break
            result = await asyncio.to_thread(self.client.delete_path, source)
            self._log(job, "debug", self._format_result("delete", source, result))
            if result.returncode != 0:
                failures = True
                job.results.append(JobItemResult(source=source, status=JobStatus.failed, error=result.stderr.strip() or "delete failed"))
                self._log(job, "error", f"delete failed for {source}: {result.stderr.strip()}")
            else:
                job.results.append(JobItemResult(source=source, status=JobStatus.success))
                self._log(job, "info", f"deleted {source}")

        if job.status != JobStatus.cancelled:
            job.status = JobStatus.failed if failures else JobStatus.success
        job.completed_at = self._now()
        self.db.upsert_job(job)

    async def _run_transfer(self, job: Job, settings: Settings) -> None:
        destination_dir = job.destination_dir or ""
        any_failures = False

        for source in job.sources:
            if job.id in self.cancelled:
                job.status = JobStatus.cancelled
                break

            base = self.client.path_basename(source)
            destination = self.client.join_remote(destination_dir, base)
            item = JobItemResult(source=source, destination=destination, status=JobStatus.running)
            item.direct_attempted = True
            self._log(job, "info", f"starting {job.operation.value}: {source} -> {destination}")

            direct = await self._copy_item(job, source, destination)
            self._log(job, "debug", self._format_result("direct-copy", source, direct))
            if direct.returncode != 0:
                self._log(job, "warning", f"direct copy failed for {source}, trying fallback")
                ok, err = await self._fallback_copy(job, source, destination, settings)
                item.fallback_used = True
                if not ok:
                    item.status = JobStatus.failed
                    item.error = err
                    job.results.append(item)
                    any_failures = True
                    continue
            verify = await asyncio.to_thread(verify_strict, self.client, source, destination)
            if not verify.passed:
                item.status = JobStatus.failed
                item.error = f"verification failed: {verify.reason}"
                job.results.append(item)
                any_failures = True
                self._log(job, "error", item.error)
                continue

            item.verify_passed = True

            if job.operation == JobOperation.move:
                delete_result = await asyncio.to_thread(self.client.delete_path, source)
                self._log(job, "debug", self._format_result("post-verify-delete", source, delete_result))
                if delete_result.returncode != 0:
                    item.status = JobStatus.failed
                    item.error = f"copy verified but source delete failed: {delete_result.stderr.strip()}"
                    job.results.append(item)
                    any_failures = True
                    self._log(job, "error", item.error)
                    continue

            item.status = JobStatus.success
            job.results.append(item)
            self._log(job, "info", f"completed {job.operation.value}: {source}")

        if job.status != JobStatus.cancelled:
            job.status = JobStatus.failed if any_failures else JobStatus.success
        job.completed_at = self._now()
        self.db.upsert_job(job)

    def _progress_callback(self, job: Job, source: str, stage: str):
        last_line = ""

        def callback(raw: str) -> None:
            nonlocal last_line
            line = " ".join(raw.strip().split())
            if not line:
                return
            if line == last_line:
                return
            if "%" not in line and "Transferred:" not in line:
                return
            last_line = line
            self._log(job, "info", f"progress [{stage}] {source} {line}")

        return callback

    async def _copy_item(self, job: Job, source: str, destination: str):
        entry = await asyncio.to_thread(self.client.stat, source)
        progress = self._progress_callback(job, source, "direct")
        if entry.is_dir:
            return await asyncio.to_thread(self.client.copy, source, destination, progress)
        return await asyncio.to_thread(self.client.copyto, source, destination, progress)

    async def _fallback_copy(self, job: Job, source: str, destination: str, settings: Settings) -> tuple[bool, str | None]:
        staging_root = Path(settings.staging_path)
        staging_root.mkdir(parents=True, exist_ok=True)
        estimate = await asyncio.to_thread(self._estimate_source_size, source)
        while self.staging_in_use_bytes + estimate > settings.staging_cap_bytes:
            self._log(
                job,
                "debug",
                f"staging cap wait: estimate={estimate} in_use={self.staging_in_use_bytes} cap={settings.staging_cap_bytes}",
            )
            await asyncio.sleep(0.5)

        self.staging_in_use_bytes += estimate
        local_path = staging_root / uuid.uuid4().hex / self.client.path_basename(source)
        try:
            entry = await asyncio.to_thread(self.client.stat, source)
            pull_progress = self._progress_callback(job, source, "fallback-pull")
            if entry.is_dir:
                pull = await asyncio.to_thread(self.client.to_local_copy, source, local_path, pull_progress)
            else:
                pull = await asyncio.to_thread(self.client.to_local_copyto, source, local_path, pull_progress)
            self._log(job, "debug", self._format_result("fallback-pull", source, pull))
            if pull.returncode != 0:
                return False, f"fallback download failed: {pull.stderr.strip()}"

            push_progress = self._progress_callback(job, source, "fallback-push")
            if entry.is_dir:
                push = await asyncio.to_thread(self.client.from_local_copy, local_path, destination, push_progress)
            else:
                push = await asyncio.to_thread(self.client.from_local_copyto, local_path, destination, push_progress)
            self._log(job, "debug", self._format_result("fallback-push", source, push))
            if push.returncode != 0:
                return False, f"fallback upload failed: {push.stderr.strip()}"

            return True, None
        finally:
            self.staging_in_use_bytes = max(0, self.staging_in_use_bytes - estimate)

    def _estimate_source_size(self, source: str) -> int:
        try:
            entries = self.client.list(source, recursive=True)
        except Exception:
            return 0
        return sum(entry.size for entry in entries if not entry.is_dir)

    def _format_result(self, stage: str, source: str, result) -> str:
        stderr = (getattr(result, "stderr", "") or "").strip()
        stdout = (getattr(result, "stdout", "") or "").strip()
        trimmed_err = stderr[:500]
        trimmed_out = stdout[:300]
        return (
            f"{stage} source={source} rc={getattr(result, 'returncode', -1)} timed_out={getattr(result, 'timed_out', False)} "
            f"duration_ms={getattr(result, 'duration_ms', 0)} stdout='{trimmed_out}' stderr='{trimmed_err}'"
        )
