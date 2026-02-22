from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import build_router
from app.config import HOST, PORT
from app.db.database import Database
from app.services.rclone import RcloneClient
from app.services.searches import SearchManager
from app.services.transfers import TransferManager


db = Database()
rclone = RcloneClient()
transfers = TransferManager(db=db, client=rclone)
searches = SearchManager(client=rclone)

logging.basicConfig(
    level=getattr(logging, os.getenv("RCLONE_HUB_LOG_LEVEL", "DEBUG").upper(), logging.DEBUG),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    searches.start()
    transfers.start()
    yield
    await searches.stop()


app = FastAPI(title="rclone-hub", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(build_router(rclone=rclone, transfers=transfers, searches=searches, settings_store=db))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=True)
