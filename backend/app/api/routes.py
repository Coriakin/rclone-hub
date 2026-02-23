from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.models.schemas import (
    CancelRequest,
    ConfigSessionContinueRequest,
    ConfigSessionQuestion,
    ConfigSessionResponse,
    ConfigSessionStartRequest,
    DeleteRequest,
    HealthResponse,
    RenamePathRequest,
    RenamePathResponse,
    RemoteConfigExample,
    RemoteConfigField,
    RemoteConfigSchema,
    RemoteConfigView,
    RemoteSummary,
    RemoteUpdateRequest,
    RemoteUpsertRequest,
    SearchCreateRequest,
    SearchCreateResponse,
    SearchEventsResponse,
    Settings,
    SizeCreateRequest,
    SizeCreateResponse,
    SizeEventsResponse,
    TransferRequest,
)
from app.services.rclone import RcloneClient, RcloneError
from app.services.searches import SearchManager
from app.services.sizes import SizeManager
from app.services.transfers import TransferManager


def build_router(rclone: RcloneClient, transfers: TransferManager, searches: SearchManager, sizes: SizeManager, settings_store) -> APIRouter:
    router = APIRouter(prefix="/api")
    image_content_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
    }
    supported_remote_types = {"b2", "drive", "smb", "crypt"}
    provider_cache: dict[str, RemoteConfigSchema] | None = None

    def _to_config_field(option: dict[str, Any]) -> RemoteConfigField:
        examples_raw = option.get("Examples") or []
        examples = []
        for item in examples_raw:
            if not isinstance(item, dict):
                continue
            value = str(item.get("Value", ""))
            help_text = str(item.get("Help", ""))
            examples.append(RemoteConfigExample(value=value, help=help_text))
        return RemoteConfigField(
            name=str(option.get("Name", "")),
            type=str(option.get("Type", "string")),
            required=bool(option.get("Required", False)),
            advanced=bool(option.get("Advanced", False)),
            is_password=bool(option.get("IsPassword", False)),
            sensitive=bool(option.get("Sensitive", False)),
            exclusive=bool(option.get("Exclusive", False)),
            default=str(option.get("DefaultStr", "")),
            help=str(option.get("Help", "")),
            examples=examples,
        )

    def _provider_schemas() -> dict[str, RemoteConfigSchema]:
        nonlocal provider_cache
        if provider_cache is not None:
            return provider_cache
        provider_cache = {}
        for provider in rclone.config_providers():
            remote_type = str(provider.get("Prefix", ""))
            if remote_type not in supported_remote_types:
                continue
            fields = [_to_config_field(opt) for opt in provider.get("Options") or [] if isinstance(opt, dict)]
            provider_cache[remote_type] = RemoteConfigSchema(
                type=remote_type,
                description=str(provider.get("Description", "")),
                fields=fields,
            )
        return provider_cache

    def _remote_summaries() -> list[RemoteSummary]:
        remotes: list[RemoteSummary] = []
        for row in rclone.list_remotes_long_json():
            name = str(row.get("name", ""))
            remote_type = str(row.get("type", ""))
            if not name or remote_type not in supported_remote_types:
                continue
            remotes.append(
                RemoteSummary(
                    name=name,
                    type=remote_type,
                    source=str(row.get("source", "")),
                    description=str(row.get("description", "")),
                )
            )
        return remotes

    def _get_remote_summary(name: str) -> RemoteSummary:
        for remote in _remote_summaries():
            if remote.name == name:
                return remote
        raise HTTPException(status_code=404, detail=f"remote not found: {name}")

    def _is_empty(value: Any) -> bool:
        return value is None or (isinstance(value, str) and value.strip() == "")

    def _normalize_values(remote_type: str, values: dict[str, Any], require_required: bool) -> dict[str, Any]:
        schema = _provider_schemas().get(remote_type)
        if schema is None:
            raise HTTPException(status_code=400, detail=f"unsupported remote type: {remote_type}")
        allowed = {field.name: field for field in schema.fields}
        normalized: dict[str, Any] = {}
        for key, value in values.items():
            if key not in allowed:
                raise HTTPException(status_code=400, detail=f"unsupported option for {remote_type}: {key}")
            field = allowed[key]
            # Blank passwords mean "leave unchanged" on update/session update.
            if field.is_password and _is_empty(value):
                continue
            normalized[key] = value
        if require_required:
            missing = [field.name for field in schema.fields if field.required and _is_empty(normalized.get(field.name))]
            if missing:
                raise HTTPException(status_code=400, detail=f"missing required options: {', '.join(missing)}")
        return normalized

    @router.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        try:
            version = rclone.version()
            config_file = rclone.config_file()
            return HealthResponse(ok=True, rclone_available=True, rclone_version=version, rclone_config_file=config_file)
        except Exception:
            return HealthResponse(ok=False, rclone_available=False)

    @router.get("/remotes")
    def remotes() -> dict[str, list[str]]:
        try:
            return {"remotes": rclone.list_remotes()}
        except RcloneError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @router.get("/remote-types")
    def remote_types() -> dict[str, list[dict[str, Any]]]:
        try:
            schemas = [schema.model_dump() for _, schema in sorted(_provider_schemas().items())]
            return {"types": schemas}
        except RcloneError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @router.get("/remotes/details")
    def remotes_details() -> dict[str, list[dict[str, Any]]]:
        try:
            return {"remotes": [remote.model_dump() for remote in _remote_summaries()]}
        except RcloneError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @router.get("/remotes/{name}/config", response_model=RemoteConfigView)
    def remote_config(name: str) -> RemoteConfigView:
        try:
            remote = _get_remote_summary(name)
            schema = _provider_schemas().get(remote.type)
            if schema is None:
                raise HTTPException(status_code=400, detail=f"unsupported remote type: {remote.type}")
            redacted = rclone.config_redacted(name)
            config_values = redacted if isinstance(redacted, dict) else {}
            fields = [
                field.model_copy(update={"value": str(config_values.get(field.name)) if field.name in config_values else None})
                for field in schema.fields
            ]
            return RemoteConfigView(name=remote.name, type=remote.type, fields=fields)
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/remotes")
    def create_remote(req: RemoteUpsertRequest) -> dict[str, bool]:
        name = req.name.strip()
        remote_type = req.type.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        if not remote_type:
            raise HTTPException(status_code=400, detail="type is required")
        if remote_type == "drive":
            raise HTTPException(status_code=400, detail="drive must be configured through /api/remotes/config-session/start")
        try:
            values = _normalize_values(remote_type, req.values or {}, require_required=True)
            rclone.config_create(name, remote_type, values)
            return {"ok": True}
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.put("/remotes/{name}")
    def update_remote(name: str, req: RemoteUpdateRequest) -> dict[str, bool]:
        name = name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        try:
            remote = _get_remote_summary(name)
            if remote.type == "drive":
                raise HTTPException(status_code=400, detail="drive must be updated through /api/remotes/config-session/start")
            values = _normalize_values(remote.type, req.values or {}, require_required=False)
            if values:
                rclone.config_update(name, values)
            return {"ok": True}
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.delete("/remotes/{name}")
    def delete_remote(name: str) -> dict[str, bool]:
        name = name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        try:
            _get_remote_summary(name)
            config = rclone.config_dump()
            for remote_name, values in config.items():
                if remote_name == name or not isinstance(values, dict):
                    continue
                if str(values.get("type", "")) != "crypt":
                    continue
                wrapped_remote = str(values.get("remote", ""))
                if wrapped_remote.startswith(f"{name}:"):
                    raise HTTPException(
                        status_code=409,
                        detail=f"cannot delete {name}: referenced by crypt remote {remote_name}",
                    )
            rclone.config_delete(name)
            return {"ok": True}
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/remotes/config-session/start", response_model=ConfigSessionResponse)
    def start_config_session(req: ConfigSessionStartRequest) -> ConfigSessionResponse:
        operation = req.operation
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        try:
            if operation == "create":
                remote_type = (req.type or "").strip()
                if not remote_type:
                    raise HTTPException(status_code=400, detail="type is required for create operation")
                values = _normalize_values(remote_type, req.values or {}, require_required=False)
                question = rclone.config_create_non_interactive(
                    name=name,
                    remote_type=remote_type,
                    values=values,
                    ask_all=req.ask_all,
                )
            else:
                remote = _get_remote_summary(name)
                remote_type = remote.type
                values = _normalize_values(remote_type, req.values or {}, require_required=False)
                question = rclone.config_update_non_interactive(
                    name=name,
                    values=values,
                    ask_all=req.ask_all,
                )
            if question is None:
                return ConfigSessionResponse(done=True, question=None)
            return ConfigSessionResponse(
                done=False,
                question=ConfigSessionQuestion(
                    state=str(question.get("state", "")),
                    option=question.get("option", {}),
                    error=str(question.get("error", "")),
                ),
            )
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/remotes/config-session/continue", response_model=ConfigSessionResponse)
    def continue_config_session(req: ConfigSessionContinueRequest) -> ConfigSessionResponse:
        operation = req.operation
        name = req.name.strip()
        state = req.state.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        if not state:
            raise HTTPException(status_code=400, detail="state is required")
        try:
            if operation == "create":
                remote_type = (req.type or "").strip()
                if not remote_type:
                    raise HTTPException(status_code=400, detail="type is required for create operation")
                values = _normalize_values(remote_type, req.values or {}, require_required=False)
                question = rclone.config_create_non_interactive(
                    name=name,
                    remote_type=remote_type,
                    values=values,
                    state=state,
                    result_value=req.result,
                    ask_all=req.ask_all,
                )
            else:
                remote = _get_remote_summary(name)
                remote_type = remote.type
                values = _normalize_values(remote_type, req.values or {}, require_required=False)
                question = rclone.config_update_non_interactive(
                    name=name,
                    values=values,
                    state=state,
                    result_value=req.result,
                    ask_all=req.ask_all,
                )
            if question is None:
                return ConfigSessionResponse(done=True, question=None)
            return ConfigSessionResponse(
                done=False,
                question=ConfigSessionQuestion(
                    state=str(question.get("state", "")),
                    option=question.get("option", {}),
                    error=str(question.get("error", "")),
                ),
            )
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/list")
    def list_items(remote_path: str = Query(...), recursive: bool = Query(False)) -> dict:
        try:
            items = rclone.list(remote_path, recursive=recursive)
            return {"items": [item.model_dump() for item in items]}
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/files/content")
    def file_content(
        remote_path: str = Query(...),
        disposition: Literal["inline", "attachment"] = Query("inline"),
    ):
        try:
            entry = rclone.stat(remote_path)
            if entry.is_dir:
                raise HTTPException(status_code=400, detail="remote_path must reference a file")

            suffix = Path(entry.name or rclone.path_basename(remote_path)).suffix.lower()
            media_type = image_content_types.get(suffix, "application/octet-stream")
            if disposition == "inline" and media_type == "application/octet-stream":
                raise HTTPException(status_code=400, detail="inline preview is only supported for jpg/jpeg/png/gif")

            filename = entry.name or rclone.path_basename(remote_path) or "file"
            stream = rclone.open_cat_stream(remote_path)
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        def iterator():
            try:
                yield from stream.iter_chunks()
            finally:
                stream.close()

        safe_filename = filename.replace('"', "")
        headers = {"Content-Disposition": f'{disposition}; filename="{safe_filename}"'}
        return StreamingResponse(iterator(), media_type=media_type, headers=headers)

    @router.post("/searches", response_model=SearchCreateResponse)
    async def create_search(req: SearchCreateRequest) -> SearchCreateResponse:
        try:
            search_id = await searches.create(
                root_path=req.root_path,
                filename_query=req.filename_query,
                min_size_mb=req.min_size_mb,
                search_mode=req.search_mode,
            )
            return SearchCreateResponse(search_id=search_id)
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/searches/{search_id}/events", response_model=SearchEventsResponse)
    async def poll_search(search_id: str, after_seq: int = Query(0, ge=0)) -> SearchEventsResponse:
        try:
            return await searches.poll(search_id, after_seq)
        except KeyError:
            raise HTTPException(status_code=404, detail="search not found") from None

    @router.post("/searches/{search_id}/cancel")
    async def cancel_search(search_id: str) -> dict[str, bool]:
        found = await searches.cancel(search_id)
        if not found:
            raise HTTPException(status_code=404, detail="search not found")
        return {"ok": True}

    @router.post("/sizes", response_model=SizeCreateResponse)
    async def create_size(req: SizeCreateRequest) -> SizeCreateResponse:
        try:
            size_id = await sizes.create(root_path=req.root_path)
            return SizeCreateResponse(size_id=size_id)
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/sizes/{size_id}/events", response_model=SizeEventsResponse)
    async def poll_size(size_id: str, after_seq: int = Query(0, ge=0)) -> SizeEventsResponse:
        try:
            return await sizes.poll(size_id, after_seq)
        except KeyError:
            raise HTTPException(status_code=404, detail="size session not found") from None

    @router.post("/sizes/{size_id}/cancel")
    async def cancel_size(size_id: str) -> dict[str, bool]:
        found = await sizes.cancel(size_id)
        if not found:
            raise HTTPException(status_code=404, detail="size session not found")
        return {"ok": True}

    @router.post("/paths/rename", response_model=RenamePathResponse)
    def rename_path(req: RenamePathRequest) -> RenamePathResponse:
        source_path = req.source_path.strip()
        new_name = req.new_name.strip()
        if not source_path:
            raise HTTPException(status_code=400, detail="source_path is required")
        if not new_name:
            raise HTTPException(status_code=400, detail="new_name is required")
        if "/" in new_name or ":" in new_name:
            raise HTTPException(status_code=400, detail="new_name cannot contain '/' or ':'")
        if new_name in {".", ".."}:
            raise HTTPException(status_code=400, detail="new_name is invalid")

        try:
            updated_path = rclone.rename_within_parent(source_path, new_name)
            return RenamePathResponse(ok=True, updated_path=updated_path)
        except RcloneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/jobs/copy")
    def create_copy(req: TransferRequest):
        if req.operation.value != "copy":
            raise HTTPException(status_code=400, detail="operation must be copy")
        job = transfers.submit_transfer(req)
        return job.model_dump()

    @router.post("/jobs/move")
    def create_move(req: TransferRequest):
        if req.operation.value != "move":
            raise HTTPException(status_code=400, detail="operation must be move")
        job = transfers.submit_transfer(req)
        return job.model_dump()

    @router.post("/jobs/delete")
    def create_delete(req: DeleteRequest):
        job = transfers.submit_delete(req)
        return job.model_dump()

    @router.post("/jobs/cancel")
    def cancel(req: CancelRequest):
        job = transfers.cancel(req.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        return job.model_dump()

    @router.get("/jobs")
    def list_jobs():
        return {"jobs": [j.model_dump() for j in transfers.list_jobs()]}

    @router.get("/jobs/{job_id}")
    def get_job(job_id: str):
        job = transfers.get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        return job.model_dump()

    @router.get("/settings")
    def get_settings():
        settings = settings_store.get_settings()
        if not settings:
            raise HTTPException(status_code=404, detail="settings not initialized")
        return settings.model_dump()

    @router.put("/settings")
    def put_settings(settings: Settings):
        settings_store.set_settings(settings)
        return settings.model_dump()

    return router
