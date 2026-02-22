import asyncio

import pytest

from app.models.schemas import Entry
from app.services.sizes import SizeManager


class FakeRclone:
    def __init__(self):
        self.tree = {
            "r:root": [
                Entry(name="a.txt", path="r:root/a.txt", is_dir=False, size=10),
                Entry(name="sub", path="r:root/sub", is_dir=True, size=0),
            ],
            "r:root/sub": [
                Entry(name="b.bin", path="r:root/sub/b.bin", is_dir=False, size=20),
            ],
        }

    def list_cancellable(self, remote_path, recursive=False, should_cancel=None, timeout=None):
        _ = timeout
        assert recursive is False
        if should_cancel and should_cancel():
            raise RuntimeError("Cancelled by user")
        return self.tree.get(remote_path, [])


class SlowRclone(FakeRclone):
    def list_cancellable(self, remote_path, recursive=False, should_cancel=None, timeout=None):
        import time

        elapsed = 0.0
        while elapsed < 0.25:
            if should_cancel and should_cancel():
                raise RuntimeError("Cancelled by user")
            time.sleep(0.02)
            elapsed += 0.02
        return super().list_cancellable(remote_path, recursive, should_cancel, timeout)


async def collect_events(manager: SizeManager, size_id: str):
    cursor = 0
    events = []
    while True:
        payload = await manager.poll(size_id, cursor)
        events.extend(payload.events)
        cursor = payload.next_seq
        if payload.done:
            return events
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_size_streams_progress_and_done():
    manager = SizeManager(client=FakeRclone())
    size_id = await manager.create("r:root")
    events = await collect_events(manager, size_id)
    progress_dirs = [event.current_dir for event in events if event.type == "progress"]
    done = [event for event in events if event.type == "done"][-1]

    assert "r:root" in progress_dirs
    assert "r:root/sub" in progress_dirs
    assert done.status == "success"
    assert done.scanned_dirs == 2
    assert done.files_count == 2
    assert done.bytes_total == 30


@pytest.mark.asyncio
async def test_size_can_be_cancelled():
    manager = SizeManager(client=SlowRclone())
    size_id = await manager.create("r:root")
    await asyncio.sleep(0.05)
    await manager.cancel(size_id)
    events = await collect_events(manager, size_id)
    done = [event for event in events if event.type == "done"][-1]
    assert done.status == "cancelled"


@pytest.mark.asyncio
async def test_size_manager_cleanup_purges_terminal_sessions():
    manager = SizeManager(client=FakeRclone())
    manager.terminal_retention_seconds = 0.1
    manager.unpolled_timeout_seconds = 5.0
    manager.start()
    try:
        size_id = await manager.create("r:root")
        await collect_events(manager, size_id)
        await asyncio.sleep(2.3)
        with pytest.raises(KeyError):
            await manager.poll(size_id, 0)
    finally:
        await manager.stop()
