"""Runtime state shared by API handlers and background certificate jobs."""

import asyncio
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

_is_applying = False
apply_state = {"domain": "", "step": "init", "message": "准备中..."}
log_queues: list[asyncio.Queue] = []


def is_applying() -> bool:
    return _is_applying


def start_apply(domain: str) -> None:
    global _is_applying
    _is_applying = True
    apply_state["domain"] = domain
    apply_state["step"] = "init"
    apply_state["message"] = "准备中..."


def finish_apply() -> None:
    global _is_applying
    _is_applying = False
    apply_state["domain"] = ""
    apply_state["step"] = "done"
    apply_state["message"] = ""


async def broadcast_log(message: str, level: str = "info", step: str = "") -> None:
    if step:
        apply_state["step"] = step
    if message:
        apply_state["message"] = message

    event = {
        "message": message,
        "level": level,
        "time": datetime.now().strftime("%H:%M:%S"),
        "step": step,
    }
    if message:
        log_level = {
            "debug": logging.DEBUG,
            "info": logging.INFO,
            "success": logging.INFO,
            "warn": logging.WARNING,
            "warning": logging.WARNING,
            "error": logging.ERROR,
        }.get(level, logging.INFO)
        logger.log(log_level, "[%s] %s", step or "runtime", message)

    dead = []
    for queue in log_queues:
        try:
            queue.put_nowait(event)
        except Exception:
            dead.append(queue)
    for queue in dead:
        log_queues.remove(queue)
