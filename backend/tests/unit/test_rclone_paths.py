from app.services.rclone import RcloneClient


def test_join_remote_handles_root():
    assert RcloneClient.join_remote("s3:", "folder") == "s3:folder"


def test_join_remote_handles_nested():
    assert RcloneClient.join_remote("s3:base/path", "child") == "s3:base/path/child"
