from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
import os
import time
import uuid

from app.models.schemas import SizeDoneEvent, SizeEventsResponse, SizeProgressEvent
from app.services.rclone import RcloneClient, RcloneError


@dataclass
class SizeSession:
    id: str
    root_path: str
    created_at: float = field(default_factory=time.monotonic)
    last_polled_at: float = field(default_factory=time.monotonic)
    seq: int = 0
    scanned_dirs: int = 0
    files_count: int = 0
    bytes_total: int = 0
    cancel_requested: bool = False
    done: bool = False
    events: list[SizeProgressEvent | SizeDoneEvent] = field(default_factory=list)
    done_at: float | None = None
    task: asyncio.Task[None] | None = None


class SizeManager:
    def __init__(self, client: RcloneClient) -> None:
        self.client = client
        self.sessions: dict[str, SizeSession] = {}
        self.lock = asyncio.Lock()
        self.cleanup_task: asyncio.Task[None] | None = None
        self.unpolled_timeout_seconds = 30.0
        self.terminal_retention_seconds = 300.0
        self.progress_heartbeat_seconds = float(os.getenv("RCLONE_HUB_SIZE_HEARTBEAT_SECONDS", "1.0"))
        self.per_dir_timeout_seconds = int(os.getenv("RCLONE_HUB_SIZE_DIR_TIMEOUT_SECONDS", "30"))

    def start(self) -> None:
        if self.cleanup_task is None:
            self.cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        if self.cleanup_task is not None:
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass
            self.cleanup_task = None

        async with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()

        for session in sessions:
            session.cancel_requested = True
            if session.task is not None and not session.task.done():
                session.task.cancel()
        for session in sessions:
            if session.task is not None:
                try:
                    await session.task
                except asyncio.CancelledError:
                    pass

    async def create(self, root_path: str) -> str:
        size_id = str(uuid.uuid4())
        session = SizeSession(id=size_id, root_path=root_path)

        async with self.lock:
            self.sessions[size_id] = session
            session.task = asyncio.create_task(self._run_size(session))
        return size_id

    async def poll(self, size_id: str, after_seq: int) -> SizeEventsResponse:
        async with self.lock:
            session = self.sessions.get(size_id)
            if session is None:
                raise KeyError(size_id)
            session.last_polled_at = time.monotonic()
            events = [event for event in session.events if event.seq > after_seq]
            return SizeEventsResponse(events=events, done=session.done, next_seq=session.seq)

    async def cancel(self, size_id: str) -> bool:
        async with self.lock:
            session = self.sessions.get(size_id)
            if session is None:
                return False
            session.cancel_requested = True
            return True

    async def _cleanup_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(2.0)
                now = time.monotonic()
                stale_terminal: list[str] = []
                async with self.lock:
                    for size_id, session in self.sessions.items():
                        if not session.done and now - session.last_polled_at > self.unpolled_timeout_seconds:
                            session.cancel_requested = True
                        if session.done and session.done_at is not None and now - session.done_at > self.terminal_retention_seconds:
                            stale_terminal.append(size_id)
                    for size_id in stale_terminal:
                        self.sessions.pop(size_id, None)
        except asyncio.CancelledError:
            return

    async def _emit_progress(self, session: SizeSession, current_dir: str) -> None:
        async with self.lock:
            if session.id not in self.sessions or session.done:
                return
            session.seq += 1
            session.events.append(
                SizeProgressEvent(
                    seq=session.seq,
                    type="progress",
                    current_dir=current_dir,
                    scanned_dirs=session.scanned_dirs,
                    files_count=session.files_count,
                    bytes_total=session.bytes_total,
                )
            )

    async def _emit_done(self, session: SizeSession, status: str, error: str | None = None) -> None:
        async with self.lock:
            if session.id not in self.sessions or session.done:
                return
            session.done = True
            session.done_at = time.monotonic()
            session.seq += 1
            session.events.append(
                SizeDoneEvent(
                    seq=session.seq,
                    type="done",
                    status=status,
                    scanned_dirs=session.scanned_dirs,
                    files_count=session.files_count,
                    bytes_total=session.bytes_total,
                    error=error,
                )
            )

    async def _run_size(self, session: SizeSession) -> None:
        dirs = deque([session.root_path])
        while dirs:
            if session.cancel_requested:
                await self._emit_done(session, "cancelled")
                return

            current_dir = dirs.popleft()
            session.scanned_dirs += 1
            await self._emit_progress(session, current_dir)

            should_cancel = lambda: session.cancel_requested
            list_task = asyncio.create_task(
                asyncio.to_thread(
                    self.client.list_cancellable,
                    current_dir,
                    False,
                    should_cancel,
                    self.per_dir_timeout_seconds,
                )
            )
            while not list_task.done():
                if session.cancel_requested:
                    await self._emit_done(session, "cancelled")
                    return
                await asyncio.sleep(self.progress_heartbeat_seconds)
                if not list_task.done():
                    await self._emit_progress(session, current_dir)

            try:
                items = await list_task
            except RcloneError as exc:
                if session.cancel_requested or "Cancelled by user" in str(exc):
                    await self._emit_done(session, "cancelled")
                    return
                await self._emit_done(session, "failed", str(exc))
                return
            except Exception as exc:
                if session.cancel_requested:
                    await self._emit_done(session, "cancelled")
                    return
                await self._emit_done(session, "failed", f"size calculation failed: {exc}")
                return

            for entry in items:
                if session.cancel_requested:
                    await self._emit_done(session, "cancelled")
                    return
                if entry.is_dir:
                    dirs.append(entry.path)
                    continue
                session.files_count += 1
                session.bytes_total += max(entry.size, 0)

        await self._emit_done(session, "success")
