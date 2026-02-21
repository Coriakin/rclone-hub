from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from app.services.rclone import RcloneClient, RcloneError


@dataclass
class VerifyResult:
    passed: bool
    reason: str


def _normalize_path(source_root: str, item_path: str, for_destination_root: str) -> str:
    _, src_prefix = RcloneClient.split_remote(source_root)
    _, dst_prefix = RcloneClient.split_remote(for_destination_root)
    _, item_rel_path = RcloneClient.split_remote(item_path)

    if src_prefix and item_rel_path.startswith(src_prefix):
        rel = item_rel_path[len(src_prefix):].lstrip("/")
    else:
        rel = item_rel_path.lstrip("/")

    if dst_prefix:
        mapped = f"{dst_prefix.rstrip('/')}/{rel}" if rel else dst_prefix
    else:
        mapped = rel
    remote, _ = RcloneClient.split_remote(for_destination_root)
    return f"{remote}:{mapped}" if mapped else f"{remote}:"


def verify_strict(client: RcloneClient, source: str, destination: str) -> VerifyResult:
    try:
        src_entries = client.list(source, recursive=True)
        dst_entries = client.list(destination, recursive=True)
    except RcloneError as exc:
        return VerifyResult(False, f"unable to list for verification: {exc}")

    src_files = [e for e in src_entries if not e.is_dir]
    dst_files = [e for e in dst_entries if not e.is_dir]

    if len(src_files) != len(dst_files):
        return VerifyResult(False, "file count mismatch")

    dst_map = {e.path: e for e in dst_files}
    for src in src_files:
        expected_dst_path = _normalize_path(source, src.path, destination)
        dst = dst_map.get(expected_dst_path)
        if not dst:
            return VerifyResult(False, f"missing destination file: {expected_dst_path}")

        if src.size != dst.size:
            return VerifyResult(False, f"size mismatch: {src.path}")

        common_hashes = set(src.hashes.keys()) & set(dst.hashes.keys())
        if common_hashes:
            mismatch = [h for h in common_hashes if src.hashes.get(h) != dst.hashes.get(h)]
            if mismatch:
                return VerifyResult(False, f"checksum mismatch ({','.join(sorted(mismatch))}): {src.path}")
        else:
            if src.mod_time and dst.mod_time:
                delta = abs((src.mod_time - dst.mod_time).total_seconds())
                if delta > 2:
                    return VerifyResult(False, f"modtime mismatch without checksum: {src.path}")

    return VerifyResult(True, "strict verification passed")
