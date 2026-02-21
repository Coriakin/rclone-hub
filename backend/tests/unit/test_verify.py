from datetime import datetime, timezone

from app.models.schemas import Entry
from app.services.verify import verify_strict


class FakeClient:
    def __init__(self, source_entries, destination_entries):
        self.source_entries = source_entries
        self.destination_entries = destination_entries

    def list(self, path, recursive=False):
        if path == "a:src":
            return self.source_entries
        if path == "b:dst":
            return self.destination_entries
        return []


def test_verify_prefers_hashes_when_available():
    src = [
        Entry(name="f", path="a:src/f.txt", is_dir=False, size=5, mod_time=datetime.now(timezone.utc), hashes={"md5": "x"}),
    ]
    dst = [
        Entry(name="f", path="b:dst/f.txt", is_dir=False, size=5, mod_time=datetime.now(timezone.utc), hashes={"md5": "x"}),
    ]
    result = verify_strict(FakeClient(src, dst), "a:src", "b:dst")
    assert result.passed


def test_verify_fails_on_size_mismatch_without_hashes():
    now = datetime.now(timezone.utc)
    src = [Entry(name="f", path="a:src/f.txt", is_dir=False, size=5, mod_time=now, hashes={})]
    dst = [Entry(name="f", path="b:dst/f.txt", is_dir=False, size=6, mod_time=now, hashes={})]
    result = verify_strict(FakeClient(src, dst), "a:src", "b:dst")
    assert not result.passed
