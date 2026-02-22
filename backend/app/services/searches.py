from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
import fnmatch
import os
import time
import uuid

from app.models.schemas import Entry, SearchDoneEvent, SearchEventsResponse, SearchProgressEvent, SearchResultEvent
from app.services.rclone import RcloneClient, RcloneError


@dataclass
class SearchSession:
    id: str
    root_path: str
    filename_query: str
    literal: bool
    min_size_bytes: int | None
    created_at: float = field(default_factory=time.monotonic)
    last_polled_at: float = field(default_factory=time.monotonic)
    seq: int = 0
    scanned_dirs: int = 0
    matched_count: int = 0
    cancel_requested: bool = False
    done: bool = False
    events: list[SearchProgressEvent | SearchResultEvent | SearchDoneEvent] = field(default_factory=list)
    done_at: float | None = None
    task: asyncio.Task[None] | None = None


class SearchManager:
    def __init__(self, client: RcloneClient) -> None:
        self.client = client
        self.sessions: dict[str, SearchSession] = {}
        self.lock = asyncio.Lock()
        self.cleanup_task: asyncio.Task[None] | None = None
        self.unpolled_timeout_seconds = 30.0
        self.terminal_retention_seconds = 300.0
        self.progress_heartbeat_seconds = float(os.getenv("RCLONE_HUB_SEARCH_HEARTBEAT_SECONDS", "1.0"))
        self.per_dir_timeout_seconds = int(os.getenv("RCLONE_HUB_SEARCH_DIR_TIMEOUT_SECONDS", "30"))

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

    async def create(self, root_path: str, filename_query: str, literal: bool, min_size_mb: float | None) -> str:
        query = filename_query.strip() or "*"
        min_size_bytes = None if min_size_mb is None else int(min_size_mb * 1024 * 1024)
        search_id = str(uuid.uuid4())
        session = SearchSession(
            id=search_id,
            root_path=root_path,
            filename_query=query,
            literal=literal,
            min_size_bytes=min_size_bytes,
        )

        async with self.lock:
            self.sessions[search_id] = session
            session.task = asyncio.create_task(self._run_search(session))
        return search_id

    async def poll(self, search_id: str, after_seq: int) -> SearchEventsResponse:
        async with self.lock:
            session = self.sessions.get(search_id)
            if session is None:
                raise KeyError(search_id)
            session.last_polled_at = time.monotonic()
            events = [event for event in session.events if event.seq > after_seq]
            return SearchEventsResponse(events=events, done=session.done, next_seq=session.seq)

    async def cancel(self, search_id: str) -> bool:
        async with self.lock:
            session = self.sessions.get(search_id)
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
                    for search_id, session in self.sessions.items():
                        if not session.done and now - session.last_polled_at > self.unpolled_timeout_seconds:
                            session.cancel_requested = True
                        if session.done and session.done_at is not None and now - session.done_at > self.terminal_retention_seconds:
                            stale_terminal.append(search_id)
                    for search_id in stale_terminal:
                        self.sessions.pop(search_id, None)
        except asyncio.CancelledError:
            return

    async def _emit_progress(self, session: SearchSession, current_dir: str) -> None:
        async with self.lock:
            if session.id not in self.sessions or session.done:
                return
            session.seq += 1
            session.events.append(
                SearchProgressEvent(
                    seq=session.seq,
                    type="progress",
                    current_dir=current_dir,
                    scanned_dirs=session.scanned_dirs,
                    matched_count=session.matched_count,
                )
            )

    async def _emit_result(self, session: SearchSession, entry: Entry) -> None:
        async with self.lock:
            if session.id not in self.sessions or session.done:
                return
            session.matched_count += 1
            session.seq += 1
            session.events.append(SearchResultEvent(seq=session.seq, type="result", entry=entry))

    async def _emit_done(self, session: SearchSession, status: str, error: str | None = None) -> None:
        async with self.lock:
            if session.id not in self.sessions or session.done:
                return
            session.done = True
            session.done_at = time.monotonic()
            session.seq += 1
            session.events.append(
                SearchDoneEvent(
                    seq=session.seq,
                    type="done",
                    status=status,
                    scanned_dirs=session.scanned_dirs,
                    matched_count=session.matched_count,
                    error=error,
                )
            )

    async def _run_search(self, session: SearchSession) -> None:
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
                await self._emit_done(session, "failed", f"search failed: {exc}")
                return

            for entry in items:
                if session.cancel_requested:
                    await self._emit_done(session, "cancelled")
                    return
                if entry.is_dir:
                    dirs.append(entry.path)
                if not self._matches(session, entry):
                    continue
                entry.parent_path = self._parent_path(entry.path)
                await self._emit_result(session, entry)

        await self._emit_done(session, "success")

    def _matches(self, session: SearchSession, entry: Entry) -> bool:
        if session.literal:
            name_ok = entry.name == session.filename_query
        else:
            name_ok = fnmatch.fnmatchcase(entry.name, session.filename_query)
        if not name_ok:
            return False
        if session.min_size_bytes is None:
            return True
        if entry.is_dir:
            return True
        return entry.size >= session.min_size_bytes

    @staticmethod
    def _parent_path(path: str) -> str:
        if ":" not in path:
            return ""
        remote, rel = path.split(":", 1)
        rel = rel.strip("/")
        if not rel:
            return f"{remote}:"
        parts = rel.split("/")
        if len(parts) == 1:
            return f"{remote}:"
        return f"{remote}:{'/'.join(parts[:-1])}"
