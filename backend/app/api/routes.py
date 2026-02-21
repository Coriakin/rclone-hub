from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.models.schemas import CancelRequest, DeleteRequest, HealthResponse, Settings, TransferRequest
from app.services.rclone import RcloneClient, RcloneError
from app.services.transfers import TransferManager


def build_router(rclone: RcloneClient, transfers: TransferManager, settings_store) -> APIRouter:
    router = APIRouter(prefix="/api")

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
