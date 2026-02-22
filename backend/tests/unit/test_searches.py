import asyncio

import pytest

from app.models.schemas import Entry
from app.services.searches import SearchManager


class FakeRclone:
    def __init__(self):
        self.tree = {
            "r:root": [
                Entry(name="small.txt", path="r:root/small.txt", is_dir=False, size=128),
                Entry(name="sub", path="r:root/sub", is_dir=True, size=0),
            ],
            "r:root/sub": [
                Entry(name="big.bin", path="r:root/sub/big.bin", is_dir=False, size=4 * 1024 * 1024),
                Entry(name="nested.txt", path="r:root/sub/nested.txt", is_dir=False, size=256),
            ],
        }

    def list(self, remote_path, recursive=False):
        assert recursive is False
        return self.tree.get(remote_path, [])

    def list_cancellable(self, remote_path, recursive=False, should_cancel=None, timeout=None):
        if should_cancel and should_cancel():
            raise RuntimeError("Cancelled by user")
        return self.list(remote_path, recursive)


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


async def collect_events(manager: SearchManager, search_id: str):
    cursor = 0
    events = []
    while True:
        payload = await manager.poll(search_id, cursor)
        events.extend(payload.events)
        cursor = payload.next_seq
        if payload.done:
            return events
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_search_streams_progress_and_results():
    manager = SearchManager(client=FakeRclone())
    search_id = await manager.create("r:root", "*.txt", False, None)

    events = await collect_events(manager, search_id)
    result_paths = [event.entry.path for event in events if event.type == "result"]
    progress_dirs = [event.current_dir for event in events if event.type == "progress"]
    done_events = [event for event in events if event.type == "done"]

    assert "r:root/small.txt" in result_paths
    assert "r:root/sub/nested.txt" in result_paths
    assert "r:root" in progress_dirs
    assert "r:root/sub" in progress_dirs
    assert done_events[-1].status == "success"


@pytest.mark.asyncio
async def test_search_min_size_filters_files_only():
    manager = SearchManager(client=FakeRclone())
    search_id = await manager.create("r:root", "*sub*", False, 1.0)
    events = await collect_events(manager, search_id)
    result_names = [event.entry.name for event in events if event.type == "result"]
    assert "sub" in result_names

    search_id_files = await manager.create("r:root", "*.txt", False, 1.0)
    file_events = await collect_events(manager, search_id_files)
    file_result_names = [event.entry.name for event in file_events if event.type == "result"]
    assert "small.txt" not in file_result_names
    assert "nested.txt" not in file_result_names


@pytest.mark.asyncio
async def test_search_can_be_cancelled():
    manager = SearchManager(client=SlowRclone())
    search_id = await manager.create("r:root", "*", False, None)
    await asyncio.sleep(0.05)
    await manager.cancel(search_id)
    events = await collect_events(manager, search_id)
    done = [event for event in events if event.type == "done"][-1]
    assert done.status == "cancelled"


@pytest.mark.asyncio
async def test_search_manager_cleanup_purges_terminal_sessions():
    manager = SearchManager(client=FakeRclone())
    manager.terminal_retention_seconds = 0.1
    manager.unpolled_timeout_seconds = 5.0
    manager.start()
    try:
        search_id = await manager.create("r:root", "*", False, None)
        await collect_events(manager, search_id)
        await asyncio.sleep(2.3)
        with pytest.raises(KeyError):
            await manager.poll(search_id, 0)
    finally:
        await manager.stop()
