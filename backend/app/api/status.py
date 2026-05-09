"""Health and runtime status routes."""

from fastapi import APIRouter

from app.core import state

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status")
async def get_status():
    return {"applying": state.is_applying()}
