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
    results: dict[str, str] = {}

    async with httpx.AsyncClient(timeout=10.0) as client:
        await asyncio.gather(
            *[_notify_pi(client, ip, request.trigger_port, results) for ip in request.pi_ips],
            return_exceptions=True,
        )

    return BroadcastResponse(triggered=results)


async def _notify_pi(
    client: httpx.AsyncClient, ip: str, port: int, results: dict[str, str]
) -> None:
    url = f"http://{ip}:{port}/trigger-update"
    try:
        resp = await client.post(url)
        results[ip] = "ok" if resp.status_code == 200 else f"error:{resp.status_code}"
    except httpx.ConnectError:
        results[ip] = "unreachable"
    except httpx.TimeoutException:
        results[ip] = "timeout"
    except Exception as exc:
        results[ip] = f"error:{exc}"
