import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastapi.responses import StreamingResponse

from app.api.routes import build_router
from app.models.schemas import Entry, Settings
from app.services.rclone import RcloneError


class FakeStream:
    def __init__(self, chunks: list[bytes], fail: bool = False):
        self._chunks = chunks
        self._fail = fail
        self.closed = False

    def iter_chunks(self, chunk_size: int = 64 * 1024):
        _ = chunk_size
        for chunk in self._chunks:
            yield chunk
        if self._fail:
            raise RcloneError("stream failed")

    def close(self):
        self.closed = True


class FakeRclone:
    def __init__(self):
        self.entries = {
            "r:photo.jpg": Entry(name="photo.jpg", path="r:photo.jpg", is_dir=False, size=4),
            "r:photo.png": Entry(name="photo.png", path="r:photo.png", is_dir=False, size=4),
            "r:photo.gif": Entry(name="photo.gif", path="r:photo.gif", is_dir=False, size=4),
            "r:folder": Entry(name="folder", path="r:folder", is_dir=True, size=0),
            "r:file.txt": Entry(name="file.txt", path="r:file.txt", is_dir=False, size=4),
        }
        self.stream = FakeStream([b"test"])
        self.should_fail_open = False

    def stat(self, remote_path: str) -> Entry:
        if remote_path not in self.entries:
            raise RcloneError("not found")
        return self.entries[remote_path]

    def path_basename(self, remote_path: str) -> str:
        return remote_path.split("/")[-1].split(":")[-1]

    def open_cat_stream(self, remote_path: str):
        _ = remote_path
        if self.should_fail_open:
            raise RcloneError("cat failed")
        return self.stream

    def version(self):
        return "rclone vtest"

    def config_file(self):
        return "~/.config/rclone/rclone.conf"

    def list_remotes(self):
        return ["r:"]

    def list(self, remote_path, recursive=False):
        _ = remote_path, recursive
        return []


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


class DummySettingsStore:
    def __init__(self):
        self.settings = Settings(staging_path="/tmp/rclone-hub", staging_cap_bytes=1024, concurrency=1, verify_mode="strict")

    def get_settings(self):
        return self.settings

    def set_settings(self, settings: Settings):
        self.settings = settings


class DummySizes:
    async def create(self, root_path: str):
        _ = root_path
        raise NotImplementedError

    async def poll(self, size_id: str, after_seq: int):
        _ = size_id, after_seq
        raise KeyError

    async def cancel(self, size_id: str):
        _ = size_id
        return False


def get_file_content_endpoint(fake_rclone: FakeRclone):
    router = build_router(
        rclone=fake_rclone,
        transfers=DummyTransfers(),
        searches=DummySearches(),
        sizes=DummySizes(),
        settings_store=DummySettingsStore(),
    )
    for route in router.routes:
        if isinstance(route, APIRoute) and route.path == "/api/files/content":
            return route.endpoint
    raise AssertionError("expected /api/files/content route to exist")


async def read_streaming_response(response: StreamingResponse) -> bytes:
    chunks: list[bytes] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_file_content_inline_image_types():
    fake_rclone = FakeRclone()
    endpoint = get_file_content_endpoint(fake_rclone)
    cases = [
        ("r:photo.jpg", "image/jpeg"),
        ("r:photo.png", "image/png"),
        ("r:photo.gif", "image/gif"),
    ]

    for remote_path, expected_content_type in cases:
        response = endpoint(remote_path=remote_path, disposition="inline")
        assert isinstance(response, StreamingResponse)
        payload = await read_streaming_response(response)
        assert payload == b"test"
        assert response.media_type == expected_content_type
        assert response.headers["content-disposition"] == f'inline; filename="{fake_rclone.entries[remote_path].name}"'


@pytest.mark.asyncio
async def test_file_content_attachment_disposition():
    fake_rclone = FakeRclone()
    endpoint = get_file_content_endpoint(fake_rclone)
    response = endpoint(remote_path="r:file.txt", disposition="attachment")
    assert isinstance(response, StreamingResponse)
    payload = await read_streaming_response(response)
    assert payload == b"test"
    assert response.media_type == "application/octet-stream"
    assert response.headers["content-disposition"] == 'attachment; filename="file.txt"'


def test_file_content_rejects_directory():
    fake_rclone = FakeRclone()
    endpoint = get_file_content_endpoint(fake_rclone)
    with pytest.raises(HTTPException) as exc:
        endpoint(remote_path="r:folder", disposition="inline")
    assert exc.value.status_code == 400
    assert "must reference a file" in str(exc.value.detail)


def test_file_content_surfaces_rclone_error():
    fake_rclone = FakeRclone()
    fake_rclone.should_fail_open = True
    endpoint = get_file_content_endpoint(fake_rclone)
    with pytest.raises(HTTPException) as exc:
        endpoint(remote_path="r:photo.jpg", disposition="inline")
    assert exc.value.status_code == 400
    assert "cat failed" in str(exc.value.detail)
