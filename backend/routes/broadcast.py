"""Broadcast endpoint — signals one or more Pi clients to check for updates now.

The Pi update agent listens on a local trigger port (default 8765).
POST /api/broadcast with a list of Pi IPs to push an immediate update check.
"""

from __future__ import annotations

import asyncio

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class BroadcastRequest(BaseModel):
    pi_ips: list[str]
    trigger_port: int = 8765


class BroadcastResponse(BaseModel):
    triggered: dict[str, str]


@router.post(
    "/broadcast",
    summary="Trigger an immediate update check on one or more Pis",
    response_model=BroadcastResponse,
)
async def broadcast_update(request: BroadcastRequest) -> BroadcastResponse:
    # Each coroutine returns its own (ip, status) pair instead of writing to a
    # shared dict.  Passing a mutable dict into concurrent coroutines is
    # error-prone: any future await added inside the write path would create a
    # real race condition.
    async with httpx.AsyncClient(timeout=10.0) as client:
        pairs: list[tuple[str, str]] = await asyncio.gather(
            *[_notify_pi(client, ip, request.trigger_port) for ip in request.pi_ips],
        )

    return BroadcastResponse(triggered=dict(pairs))


async def _notify_pi(
    client: httpx.AsyncClient, ip: str, port: int
) -> tuple[str, str]:
    url = f"http://{ip}:{port}/trigger-update"
    try:
        resp = await client.post(url)
        status = "ok" if resp.status_code == 200 else f"error:{resp.status_code}"
    except httpx.ConnectError:
        status = "unreachable"
    except httpx.TimeoutException:
        status = "timeout"
    except Exception as exc:
        status = f"error:{exc}"
    return ip, status
