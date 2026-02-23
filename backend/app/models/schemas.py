from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal, Union
from pydantic import BaseModel, Field


class Entry(BaseModel):
    name: str
    path: str
    parent_path: str | None = None
    is_dir: bool
    size: int = 0
    mod_time: datetime | None = None
    hashes: dict[str, str] = Field(default_factory=dict)


class VerifyMode(str, Enum):
    strict = "strict"


class FallbackMode(str, Enum):
    auto = "auto"


class JobOperation(str, Enum):
    copy = "copy"
    move = "move"
    delete = "delete"


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    success = "success"
    failed = "failed"
    cancelled = "cancelled"
    interrupted = "interrupted"


class TransferRequest(BaseModel):
    sources: list[str]
    destination_dir: str
    operation: JobOperation
    fallback_mode: FallbackMode = FallbackMode.auto
    verify_mode: VerifyMode = VerifyMode.strict


class DeleteRequest(BaseModel):
    sources: list[str]


class CancelRequest(BaseModel):
    job_id: str


class RenamePathRequest(BaseModel):
    source_path: str
    new_name: str


class RenamePathResponse(BaseModel):
    ok: bool
    updated_path: str


class JobLog(BaseModel):
    ts: datetime
    level: str
    message: str


class JobItemResult(BaseModel):
    source: str
    destination: str | None = None
    status: JobStatus
    direct_attempted: bool = False
    fallback_used: bool = False
    verify_passed: bool = False
    error: str | None = None


class Job(BaseModel):
    id: str
    operation: JobOperation
    status: JobStatus
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    sources: list[str]
    destination_dir: str | None = None
    fallback_mode: FallbackMode | None = None
    verify_mode: VerifyMode | None = None
    results: list[JobItemResult] = Field(default_factory=list)
    logs: list[JobLog] = Field(default_factory=list)


class Settings(BaseModel):
    staging_path: str
    staging_cap_bytes: int = 20 * 1024 * 1024 * 1024
    concurrency: int = 2
    verify_mode: VerifyMode = VerifyMode.strict


class HealthResponse(BaseModel):
    ok: bool
    rclone_available: bool
    rclone_version: str | None = None
    rclone_config_file: str | None = None


class SearchCreateRequest(BaseModel):
    root_path: str
    filename_query: str = "*"
    min_size_mb: float | None = Field(default=None, ge=0)


class SearchCreateResponse(BaseModel):
    search_id: str


class SearchProgressEvent(BaseModel):
    seq: int
    type: Literal["progress"]
    current_dir: str
    scanned_dirs: int
    matched_count: int


class SearchResultEvent(BaseModel):
    seq: int
    type: Literal["result"]
    entry: Entry


class SearchDoneEvent(BaseModel):
    seq: int
    type: Literal["done"]
    status: Literal["success", "cancelled", "failed"]
    scanned_dirs: int
    matched_count: int
    error: str | None = None


SearchEvent = Annotated[Union[SearchProgressEvent, SearchResultEvent, SearchDoneEvent], Field(discriminator="type")]


class SearchEventsResponse(BaseModel):
    events: list[SearchEvent]
    done: bool
    next_seq: int


class SizeCreateRequest(BaseModel):
    root_path: str


class SizeCreateResponse(BaseModel):
    size_id: str


class SizeProgressEvent(BaseModel):
    seq: int
    type: Literal["progress"]
    current_dir: str
    scanned_dirs: int
    files_count: int
    bytes_total: int


class SizeDoneEvent(BaseModel):
    seq: int
    type: Literal["done"]
    status: Literal["success", "cancelled", "failed"]
    scanned_dirs: int
    files_count: int
    bytes_total: int
    error: str | None = None


SizeEvent = Annotated[Union[SizeProgressEvent, SizeDoneEvent], Field(discriminator="type")]


class SizeEventsResponse(BaseModel):
    events: list[SizeEvent]
    done: bool
    next_seq: int


class RemoteSummary(BaseModel):
    name: str
    type: str
    source: str
    description: str = ""


class RemoteConfigExample(BaseModel):
    value: str
    help: str


class RemoteConfigField(BaseModel):
    name: str
    type: str
    required: bool
    advanced: bool
    is_password: bool
    sensitive: bool
    exclusive: bool = False
    default: str = ""
    help: str = ""
    examples: list[RemoteConfigExample] = Field(default_factory=list)
    value: str | None = None


class RemoteConfigSchema(BaseModel):
    type: str
    description: str
    fields: list[RemoteConfigField]


class RemoteConfigView(BaseModel):
    name: str
    type: str
    fields: list[RemoteConfigField]


class RemoteUpsertRequest(BaseModel):
    name: str
    type: str
    values: dict[str, Any] = Field(default_factory=dict)


class RemoteUpdateRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


class ConfigSessionQuestion(BaseModel):
    state: str
    option: dict[str, Any]
    error: str = ""


class ConfigSessionStartRequest(BaseModel):
    operation: Literal["create", "update"]
    name: str
    type: str | None = None
    values: dict[str, Any] = Field(default_factory=dict)
    ask_all: bool = False


class ConfigSessionContinueRequest(BaseModel):
    operation: Literal["create", "update"]
    name: str
    type: str | None = None
    values: dict[str, Any] = Field(default_factory=dict)
    state: str
    result: str
    ask_all: bool = False


class ConfigSessionResponse(BaseModel):
    done: bool
    question: ConfigSessionQuestion | None = None
