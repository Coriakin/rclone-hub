from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import shlex
import subprocess
import time

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

    def copy(self, source: str, destination_dir: str) -> CommandResult:
        return self.run(["copy", source, destination_dir, "--create-empty-src-dirs", "--progress=false"])

    def copyto(self, source: str, destination: str) -> CommandResult:
        return self.run(["copyto", source, destination, "--create-empty-src-dirs", "--progress=false"])

    def delete_path(self, source: str) -> CommandResult:
        return self.run(["delete", source, "--rmdirs"])

    def to_local_copyto(self, source_remote: str, destination_local: Path) -> CommandResult:
        destination_local.parent.mkdir(parents=True, exist_ok=True)
        return self.run(["copyto", source_remote, str(destination_local), "--create-empty-src-dirs", "--progress=false"])

    def from_local_copyto(self, source_local: Path, destination_remote: str) -> CommandResult:
        return self.run(["copyto", str(source_local), destination_remote, "--create-empty-src-dirs", "--progress=false"])

    def to_local_copy(self, source_remote: str, destination_local_dir: Path) -> CommandResult:
        destination_local_dir.mkdir(parents=True, exist_ok=True)
        return self.run(["copy", source_remote, str(destination_local_dir), "--create-empty-src-dirs", "--progress=false"])

    def from_local_copy(self, source_local_dir: Path, destination_remote_dir: str) -> CommandResult:
        return self.run(["copy", str(source_local_dir), destination_remote_dir, "--create-empty-src-dirs", "--progress=false"])
