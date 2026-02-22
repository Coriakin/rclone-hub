import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute

from app.api.routes import build_router
from app.models.schemas import Entry, Settings, SizeDoneEvent, SizeEventsResponse
from app.services.rclone import RcloneError


class FakeRclone:
    def rename_within_parent(self, source_path: str, new_name: str) -> str:
        if source_path == "r:missing":
            raise RcloneError("not found")
        root = source_path.rsplit("/", 1)[0] if "/" in source_path else source_path.split(":", 1)[0] + ":"
        return f"{root}/{new_name}" if root.endswith(":") is False else f"{root}{new_name}"

    def version(self):
        return "rclone vtest"

    def config_file(self):
        return "~/.config/rclone/rclone.conf"

    def list_remotes(self):
        return ["r:"]

    def list(self, remote_path, recursive=False):
        _ = remote_path, recursive
        return []

    def stat(self, remote_path: str) -> Entry:
        return Entry(name="f.txt", path=remote_path, is_dir=False, size=1)

    def path_basename(self, remote_path: str) -> str:
        return remote_path.split("/")[-1]

    def open_cat_stream(self, remote_path: str):
        _ = remote_path
        raise RuntimeError("unused")


class DummyTransfers:
    def submit_transfer(self, req):
        _ = req
        raise NotImplementedError

    def submit_delete(self, req):
        _ = req
        raise NotImplementedError

    def cancel(self, job_id):
        _ = job_id
        return None

    def list_jobs(self):
        return []

    def get_job(self, job_id):
        _ = job_id
        return None


class DummySearches:
    async def create(self, **kwargs):
        _ = kwargs
        raise NotImplementedError

    async def poll(self, search_id: str, after_seq: int):
        _ = search_id, after_seq
        raise KeyError

    async def cancel(self, search_id: str):
        _ = search_id
        return False


class DummySizes:
    async def create(self, root_path: str):
        _ = root_path
        return "size-1"

    async def poll(self, size_id: str, after_seq: int):
        _ = after_seq
        if size_id != "size-1":
            raise KeyError
        return SizeEventsResponse(
            events=[SizeDoneEvent(seq=1, type="done", status="success", scanned_dirs=1, files_count=0, bytes_total=0, error=None)],
            done=True,
            next_seq=1,
        )

    async def cancel(self, size_id: str):
        return size_id == "size-1"


class DummySettingsStore:
    def __init__(self):
        self.settings = Settings(staging_path="/tmp/rclone-hub", staging_cap_bytes=1024, concurrency=1, verify_mode="strict")

    def get_settings(self):
        return self.settings

    def set_settings(self, settings: Settings):
        self.settings = settings


def get_endpoint(path: str):
    router = build_router(
        rclone=FakeRclone(),
        transfers=DummyTransfers(),
        searches=DummySearches(),
        sizes=DummySizes(),
        settings_store=DummySettingsStore(),
    )
    for route in router.routes:
        if isinstance(route, APIRoute) and route.path == path:
            return route.endpoint
    raise AssertionError(f"expected {path} route to exist")


def test_rename_route_success():
    endpoint = get_endpoint("/api/paths/rename")
    response = endpoint(type("Req", (), {"source_path": "r:dir/old.txt", "new_name": "new.txt"})())
    assert response.ok is True
    assert response.updated_path == "r:dir/new.txt"


def test_rename_route_validation_rejects_invalid_name():
    endpoint = get_endpoint("/api/paths/rename")
    with pytest.raises(HTTPException) as exc:
        endpoint(type("Req", (), {"source_path": "r:dir/old.txt", "new_name": "bad/name"})())
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_sizes_routes_contract():
    create = get_endpoint("/api/sizes")
    poll = get_endpoint("/api/sizes/{size_id}/events")
    cancel = get_endpoint("/api/sizes/{size_id}/cancel")

    created = await create(type("Req", (), {"root_path": "r:root"})())
    assert created.size_id == "size-1"

    payload = await poll(size_id="size-1", after_seq=0)
    assert payload.done is True
    assert payload.next_seq == 1
    done = payload.events[-1]
    assert done.type == "done"
    assert done.status == "success"

    cancelled = await cancel(size_id="size-1")
    assert cancelled == {"ok": True}
