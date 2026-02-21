import asyncio
from contextlib import suppress

from app.db.database import Database
from app.models.schemas import DeleteRequest, JobOperation, JobStatus, TransferRequest
from app.services.transfers import TransferManager


class FakeResult:
    def __init__(self, returncode=0, stderr=""):
        self.returncode = returncode
        self.stderr = stderr


class FakeRclone:
    def __init__(self):
        self.first_copy = True

    def path_basename(self, source):
        return source.split(":")[-1].split("/")[-1]

    def join_remote(self, destination, base):
        return f"{destination.rstrip('/')}/{base}"

    def copy(self, source, destination):
        if self.first_copy:
            self.first_copy = False
            return FakeResult(returncode=1, stderr="failed")
        return FakeResult(returncode=0)

    def copyto(self, source, destination):
        return self.copy(source, destination)

    def stat(self, source):
        from app.models.schemas import Entry
        return Entry(name="f", path=source, is_dir=False, size=1, hashes={"md5": "a"})

    def to_local_copyto(self, source, destination):
        return FakeResult(returncode=0)

    def from_local_copyto(self, source, destination):
        return FakeResult(returncode=0)

    def list(self, source, recursive=False):
        from app.models.schemas import Entry
        return [Entry(name="f", path=source.rstrip('/') + "/f.txt", is_dir=False, size=1, hashes={"md5": "a"})]

    def delete_path(self, source):
        return FakeResult(returncode=0)


async def test_copy_fallback_runs(tmp_path):
    db = Database(db_path=tmp_path / "test.db")
    manager = TransferManager(db=db, client=FakeRclone())

    req = TransferRequest(
        operation=JobOperation.copy,
        sources=["a:src"],
        destination_dir="b:dst",
    )
    job = manager.submit_transfer(req)
    settings = db.get_settings()
    assert settings is not None
    await manager._run_transfer(job, settings)

    stored = manager.get_job(job.id)
    assert stored is not None
    assert stored.results[0].fallback_used


async def test_delete_job(tmp_path):
    db = Database(db_path=tmp_path / "test.db")
    manager = TransferManager(db=db, client=FakeRclone())
    job = manager.submit_delete(DeleteRequest(sources=["a:tmp"]))
    await manager._run_delete(job)
    assert manager.get_job(job.id).status.value == "success"


async def test_start_marks_running_jobs_interrupted(tmp_path):
    db = Database(db_path=tmp_path / "test.db")
    initial = TransferManager(db=db, client=FakeRclone())
    job = initial.submit_delete(DeleteRequest(sources=["a:tmp"]))
    job.status = JobStatus.running
    db.upsert_job(job)

    manager = TransferManager(db=db, client=FakeRclone())
    manager.start()

    reloaded = manager.get_job(job.id)
    assert reloaded is not None
    assert reloaded.status == JobStatus.interrupted

    if manager.worker_task:
        manager.worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await manager.worker_task
