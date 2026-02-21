from app.models.schemas import Entry
from app.services.rclone import RcloneClient, RcloneError


class StubRclone(RcloneClient):
    def __init__(self, entry=None, stat_raises=False):
        super().__init__(binary='rclone')
        self._entry = entry
        self._stat_raises = stat_raises
        self.calls = []

    def stat(self, remote_path: str):
        if self._stat_raises:
            raise RcloneError('stat failed')
        return self._entry

    def run(self, args, timeout=None, retries=None):
        self.calls.append(args)

        class Result:
            returncode = 0
            stdout = ''
            stderr = ''
            duration_ms = 0
            timed_out = False

        return Result()


def test_delete_path_uses_deletefile_for_files():
    client = StubRclone(entry=Entry(name='f', path='a:f.txt', is_dir=False, size=1))
    client.delete_path('a:f.txt')
    assert client.calls[-1] == ['deletefile', 'a:f.txt']


def test_delete_path_uses_delete_rmdirs_for_dirs():
    client = StubRclone(entry=Entry(name='d', path='a:dir', is_dir=True, size=0))
    client.delete_path('a:dir')
    assert client.calls[-1] == ['delete', 'a:dir', '--rmdirs']


def test_delete_path_falls_back_when_stat_fails():
    client = StubRclone(stat_raises=True)
    client.delete_path('a:unknown')
    assert client.calls[-1] == ['delete', 'a:unknown', '--rmdirs']
