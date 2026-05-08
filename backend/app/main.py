"""FastAPI application factory."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api import certificates, logs, status
from app.core.config import setup_logging
from app.db import database as db

setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.init_db()
    logger.info("AutoCert backend started")
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="AutoCert", version="2.0.0", lifespan=lifespan)
    app.include_router(certificates.router)
    app.include_router(logs.router)
    app.include_router(status.router)

    static_dir = Path(__file__).resolve().parents[2] / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return app


app = create_app()
