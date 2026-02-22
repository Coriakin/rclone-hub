from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.models.schemas import (
    CancelRequest,
    DeleteRequest,
    HealthResponse,
    SearchCreateRequest,
    SearchCreateResponse,
    SearchEventsResponse,
    Settings,
    TransferRequest,
)
from app.services.rclone import RcloneClient, RcloneError
from app.services.searches import SearchManager
from app.services.transfers import TransferManager


def build_router(rclone: RcloneClient, transfers: TransferManager, searches: SearchManager, settings_store) -> APIRouter:
    router = APIRouter(prefix="/api")
    image_content_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
    }

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
