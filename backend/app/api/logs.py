"""SSE runtime log routes."""

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.core import state

router = APIRouter(prefix="/api", tags=["logs"])


@router.get("/logs")
async def sse_logs(request: Request):
    queue: asyncio.Queue = asyncio.Queue()
    state.log_queues.append(queue)

    async def stream():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if queue in state.log_queues:
                state.log_queues.remove(queue)

    return StreamingResponse(stream(), media_type="text/event-stream")
