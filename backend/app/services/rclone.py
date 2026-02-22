from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import shlex
import subprocess
import threading
import time
from typing import BinaryIO, Callable, Iterator

from app.models.schemas import Entry


class RcloneError(RuntimeError):
    pass


@dataclass
class CommandResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False


@dataclass
class BinaryStreamHandle:
    args: list[str]
    process: subprocess.Popen[bytes]
    stdout: BinaryIO
    stderr: BinaryIO | None

    def iter_chunks(self, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
        while True:
            chunk = self.stdout.read(chunk_size)
            if not chunk:
                break
            yield chunk

        returncode = self.process.wait()
        stderr_raw = self.stderr.read() if self.stderr is not None else b""
        stderr_text = stderr_raw.decode("utf-8", "replace").strip()
        if returncode != 0:
            raise RcloneError(f"command failed: {RcloneClient._as_cmd(self.args)}\n{stderr_text}")

    def close(self) -> None:
        try:
            self.stdout.close()
        except Exception:
            pass
        if self.stderr is not None:
            try:
                self.stderr.close()
            except Exception:
                pass
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()


class RcloneClient:
    def __init__(self, binary: str = "rclone") -> None:
        self.binary = binary
        self.logger = logging.getLogger(__name__)
        self.timeout_seconds = int(os.getenv("RCLONE_HUB_RCLONE_TIMEOUT_SECONDS", "300"))
        self.max_retries = int(os.getenv("RCLONE_HUB_RCLONE_MAX_RETRIES", "1"))
        self.base_flags = shlex.split(os.getenv("RCLONE_HUB_RCLONE_FLAGS", ""))

    def run(self, args: list[str], timeout: int | None = None, retries: int | None = None) -> CommandResult:
        timeout = timeout if timeout is not None else self.timeout_seconds
        attempts = (retries if retries is not None else self.max_retries) + 1
        cmd = [self.binary, *self.base_flags, *args]
        last: CommandResult | None = None
        for attempt in range(1, attempts + 1):
            start = time.monotonic()
            self.logger.info("rclone exec start attempt=%s timeout=%ss cmd=%s", attempt, timeout, self._as_cmd(cmd))
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
                result = CommandResult(
                    args=cmd,
                    returncode=proc.returncode,
                    stdout=proc.stdout,
                    stderr=proc.stderr,
                    duration_ms=int((time.monotonic() - start) * 1000),
                    timed_out=False,
                )
            except subprocess.TimeoutExpired as exc:
                result = CommandResult(
                    args=cmd,
                    returncode=124,
                    stdout=exc.stdout or "",
                    stderr=(exc.stderr or "") + f"\nTimed out after {timeout}s",
                    duration_ms=int((time.monotonic() - start) * 1000),
                    timed_out=True,
                )
            self.logger.info(
                "rclone exec end attempt=%s rc=%s duration_ms=%s stdout_len=%s stderr_len=%s",
                attempt,
                result.returncode,
                result.duration_ms,
                len(result.stdout),
                len(result.stderr),
            )
            if result.returncode == 0:
                return result
            last = result
        return last if last is not None else CommandResult(args=cmd, returncode=1, stdout="", stderr="unknown failure", duration_ms=0)

    def run_checked(self, args: list[str]) -> CommandResult:
        result = self.run(args)
        if result.returncode != 0:
            raise RcloneError(f"command failed: {self._as_cmd(result.args)}\n{result.stderr.strip()}")
        return result

    def run_with_progress(
        self,
        args: list[str],
        on_progress: Callable[[str], None],
        should_cancel: Callable[[], bool] | None = None,
        timeout: int | None = None,
    ) -> CommandResult:
        timeout = timeout if timeout is not None else self.timeout_seconds
        cmd = [self.binary, *self.base_flags, *args]
        start = time.monotonic()
        self.logger.info("rclone exec start timeout=%ss cmd=%s", timeout, self._as_cmd(cmd))
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        timed_out = False
        cancelled = False
        deadline = time.monotonic() + timeout

        def drain_stdout() -> None:
            if proc.stdout is None:
                return
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                stdout_chunks.append(chunk)

        def drain_stderr() -> None:
            if proc.stderr is None:
                return
            while True:
                line = proc.stderr.readline()
                if not line:
                    break
                stderr_chunks.append(line)
                on_progress(line.rstrip())

        stdout_thread = threading.Thread(target=drain_stdout, name="rclone-stdout-drain", daemon=True)
        stderr_thread = threading.Thread(target=drain_stderr, name="rclone-stderr-drain", daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        try:
            while True:
                if should_cancel is not None and should_cancel():
                    cancelled = True
                    proc.kill()
                    break

                if time.monotonic() > deadline:
                    timed_out = True
                    proc.kill()
                    break

                if proc.poll() is not None:
                    break

                time.sleep(0.05)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            stdout_thread.join(timeout=1.0)
            stderr_thread.join(timeout=1.0)

        stdout = "".join(stdout_chunks)
        stderr = "".join(stderr_chunks)
        if timed_out:
            stderr = (stderr + f"\nTimed out after {timeout}s").strip()
        if cancelled:
            stderr = (stderr + "\nCancelled by user").strip()

        result = CommandResult(
            args=cmd,
            returncode=130 if cancelled else (124 if timed_out else proc.returncode),
            stdout=stdout,
            stderr=stderr,
            duration_ms=int((time.monotonic() - start) * 1000),
            timed_out=timed_out,
        )
        self.logger.info(
            "rclone exec end rc=%s duration_ms=%s stdout_len=%s stderr_len=%s",
            result.returncode,
            result.duration_ms,
            len(result.stdout),
            len(result.stderr),
        )
        return result

    @staticmethod
    def _as_cmd(args: list[str]) -> str:
        return " ".join(shlex.quote(a) for a in args)

    def version(self) -> str:
        result = self.run_checked(["version", "--check=false"])
        return result.stdout.strip().splitlines()[0] if result.stdout else "unknown"

    def config_file(self) -> str:
        result = self.run_checked(["config", "file"])
        out = result.stdout.strip().splitlines()
        return out[-1] if out else ""

    def list_remotes(self) -> list[str]:
        result = self.run_checked(["listremotes"])
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def list(self, remote_path: str, recursive: bool = False) -> list[Entry]:
        args = ["lsjson", remote_path, "--hash", "--metadata", "--files-only=false"]
        if recursive:
            args.append("--recursive")
        result = self.run_checked(args)
        payload = json.loads(result.stdout or "[]")
        entries: list[Entry] = []
        for item in payload:
            entries.append(
                Entry(
                    name=item.get("Name", ""),
                    path=self.join_remote(remote_path, item.get("Path", item.get("Name", ""))),
                    is_dir=bool(item.get("IsDir", False)),
                    size=int(item.get("Size", 0)),
                    mod_time=self._parse_time(item.get("ModTime")),
                    hashes=item.get("Hashes", {}) or {},
                )
            )
        return entries

    def list_cancellable(
        self,
        remote_path: str,
        recursive: bool = False,
        should_cancel: Callable[[], bool] | None = None,
        timeout: int | None = None,
    ) -> list[Entry]:
        args = ["lsjson", remote_path, "--hash", "--metadata", "--files-only=false"]
        if recursive:
            args.append("--recursive")
        result = self.run_with_progress(
            args,
            on_progress=lambda _line: None,
            should_cancel=should_cancel,
            timeout=timeout,
        )
        if result.returncode != 0:
            raise RcloneError(f"command failed: {self._as_cmd(result.args)}\n{result.stderr.strip()}")
        payload = json.loads(result.stdout or "[]")
        entries: list[Entry] = []
        for item in payload:
            entries.append(
                Entry(
                    name=item.get("Name", ""),
                    path=self.join_remote(remote_path, item.get("Path", item.get("Name", ""))),
                    is_dir=bool(item.get("IsDir", False)),
                    size=int(item.get("Size", 0)),
                    mod_time=self._parse_time(item.get("ModTime")),
                    hashes=item.get("Hashes", {}) or {},
                )
            )
        return entries

    def stat(self, remote_path: str) -> Entry:
        result = self.run_checked(["lsjson", remote_path, "--stat", "--hash", "--metadata"])
        item = json.loads(result.stdout or "{}")
        return Entry(
            name=item.get("Name", ""),
            path=remote_path,
            is_dir=bool(item.get("IsDir", False)),
            size=int(item.get("Size", 0)),
            mod_time=self._parse_time(item.get("ModTime")),
            hashes=item.get("Hashes", {}) or {},
        )

    @staticmethod
    def _parse_time(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    @staticmethod
    def split_remote(remote_path: str) -> tuple[str, str]:
        if ":" not in remote_path:
            raise RcloneError(f"invalid remote path: {remote_path}")
        remote, path = remote_path.split(":", 1)
        return remote, path.lstrip("/")

    @staticmethod
    def join_remote(base: str, child: str) -> str:
        remote, path = RcloneClient.split_remote(base)
        if not path:
            joined = child.strip("/")
        elif not child:
            joined = path
        else:
            joined = f"{path.rstrip('/')}/{child.strip('/')}"
        return f"{remote}:{joined}" if joined else f"{remote}:"

    def path_basename(self, remote_path: str) -> str:
        _, path = self.split_remote(remote_path)
        return Path(path).name

    def path_dirname(self, remote_path: str) -> str:
        remote, path = self.split_remote(remote_path)
        normalized = path.strip("/")
        if not normalized:
            return f"{remote}:"
        parts = normalized.split("/")
        if len(parts) == 1:
            return f"{remote}:"
        return f"{remote}:{'/'.join(parts[:-1])}"

    def rename_within_parent(self, source_path: str, new_name: str) -> str:
        current_name = self.path_basename(source_path)
        if not current_name:
            raise RcloneError("cannot rename remote root")
        if current_name == new_name:
            return source_path
        parent_path = self.path_dirname(source_path)
        destination = self.join_remote(parent_path, new_name)
        self.run_checked(["moveto", source_path, destination])
        return destination

    def copy(
        self,
        source: str,
        destination_dir: str,
        on_progress: Callable[[str], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> CommandResult:
        if on_progress is not None:
            return self.run_with_progress(
                ["copy", source, destination_dir, "--stats=1s", "--stats-one-line", "--stats-log-level", "NOTICE"],
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        return self.run(["copy", source, destination_dir, "--progress=false"])

    def copyto(
        self,
        source: str,
        destination: str,
        on_progress: Callable[[str], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> CommandResult:
        if on_progress is not None:
            return self.run_with_progress(
                ["copyto", source, destination, "--stats=1s", "--stats-one-line", "--stats-log-level", "NOTICE"],
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        return self.run(["copyto", source, destination, "--progress=false"])

    def delete_path(self, source: str) -> CommandResult:
        try:
            entry = self.stat(source)
        except RcloneError:
            # Keep legacy behavior as fallback when stat cannot determine type.
            return self.run(["delete", source, "--rmdirs"])
        if entry.is_dir:
            return self.run(["delete", source, "--rmdirs"])
        return self.run(["deletefile", source])

    def to_local_copyto(
        self,
        source_remote: str,
        destination_local: Path,
        on_progress: Callable[[str], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> CommandResult:
        destination_local.parent.mkdir(parents=True, exist_ok=True)
        if on_progress is not None:
            return self.run_with_progress(
                ["copyto", source_remote, str(destination_local), "--stats=1s", "--stats-one-line", "--stats-log-level", "NOTICE"],
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        return self.run(["copyto", source_remote, str(destination_local), "--progress=false"])

    def from_local_copyto(
        self,
        source_local: Path,
        destination_remote: str,
        on_progress: Callable[[str], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> CommandResult:
        if on_progress is not None:
            return self.run_with_progress(
                ["copyto", str(source_local), destination_remote, "--stats=1s", "--stats-one-line", "--stats-log-level", "NOTICE"],
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        return self.run(["copyto", str(source_local), destination_remote, "--progress=false"])

    def to_local_copy(
        self,
        source_remote: str,
        destination_local_dir: Path,
        on_progress: Callable[[str], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> CommandResult:
        destination_local_dir.mkdir(parents=True, exist_ok=True)
        if on_progress is not None:
            return self.run_with_progress(
                ["copy", source_remote, str(destination_local_dir), "--stats=1s", "--stats-one-line", "--stats-log-level", "NOTICE"],
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        return self.run(["copy", source_remote, str(destination_local_dir), "--progress=false"])

    def from_local_copy(
        self,
        source_local_dir: Path,
        destination_remote_dir: str,
        on_progress: Callable[[str], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> CommandResult:
        if on_progress is not None:
            return self.run_with_progress(
                ["copy", str(source_local_dir), destination_remote_dir, "--stats=1s", "--stats-one-line", "--stats-log-level", "NOTICE"],
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        return self.run(["copy", str(source_local_dir), destination_remote_dir, "--progress=false"])

    def open_cat_stream(self, remote_path: str) -> BinaryStreamHandle:
        cmd = [self.binary, *self.base_flags, "cat", remote_path]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
            )
        except OSError as exc:
            raise RcloneError(f"failed to start command: {self._as_cmd(cmd)}\n{exc}") from exc
        if proc.stdout is None:
            proc.kill()
            proc.wait()
            raise RcloneError(f"failed to open stdout stream: {self._as_cmd(cmd)}")
        return BinaryStreamHandle(args=cmd, process=proc, stdout=proc.stdout, stderr=proc.stderr)
