#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx


DEFAULT_SERVER = os.getenv("BELLFORGE_SERVER_URL", "http://127.0.0.1:8000")
DEFAULT_FINGERPRINT = os.getenv("BELLFORGE_DEVICE_FINGERPRINT", "unknown-device")
TOKEN_FILE = Path(os.getenv("BELLFORGE_DEVICE_TOKEN_FILE", "./config/device_auth.json"))


def _save_tokens(payload: dict[str, Any]) -> None:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def init_pairing(base_url: str, device_name: str, fingerprint: str, network_id: str | None) -> dict[str, Any]:
    response = httpx.post(
        f"{base_url}/api/devices/pairing/init",
        timeout=10.0,
        json={
            "device_name": device_name,
            "device_fingerprint": fingerprint,
            "network_id": network_id,
        },
    )
    response.raise_for_status()
    return response.json()


def poll_pairing(base_url: str, pairing_token: str, fingerprint: str, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        response = httpx.post(
            f"{base_url}/api/devices/pairing/status",
            timeout=10.0,
            json={
                "pairing_token": pairing_token,
                "device_fingerprint": fingerprint,
            },
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("paired"):
            return payload
        time.sleep(3)
    raise TimeoutError("Timed out waiting for pairing approval.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap a BellForge device using pairing code/QR flow.")
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--device-name", required=True)
    parser.add_argument("--fingerprint", default=DEFAULT_FINGERPRINT)
    parser.add_argument("--network-id", default=None)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    init_payload = init_pairing(args.server, args.device_name, args.fingerprint, args.network_id)
    print(f"Pairing code: {init_payload['pairing_code']}")
    print("Open BellForge web app or extension, then claim this device by code or QR payload.")
    print(f"Pairing token (for QR payload): {init_payload['pairing_token']}")

    final_payload = poll_pairing(args.server, init_payload["pairing_token"], args.fingerprint, args.timeout)
    _save_tokens(
        {
            "device_id": final_payload["device_id"],
            "owner_user_id": final_payload["owner_user_id"],
            "device_token": final_payload["device_token"],
            "permissions": final_payload["permissions"],
            "org_id": final_payload.get("org_id"),
            "classroom_id": final_payload.get("classroom_id"),
        }
    )
    print(f"Device linked successfully: {final_payload['device_id']}")
    print(f"Token saved: {TOKEN_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
