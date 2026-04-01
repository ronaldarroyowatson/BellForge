#!/usr/bin/env python3
"""CLI helper for BellForge display pipeline diagnostics."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any


def _fetch_json(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def _print_human(payload: dict[str, Any]) -> None:
    print(f"timestamp: {payload.get('timestamp')}")
    print(f"health:    {payload.get('health')}")
    print(f"version:   {payload.get('version')}")
    print(f"kiosk:     {payload.get('kiosk_url')}")

    services = payload.get("services", {})
    for key in ("backend", "client", "updater", "display_manager"):
        state = services.get(key, {})
        print(f"service.{key}: active={state.get('active')} enabled={state.get('enabled')}")

    probes = payload.get("http_probes", {})
    for key in ("backend_health", "kiosk_url", "status_url"):
        probe = probes.get(key, {})
        print(f"probe.{key}: ok={probe.get('ok')} status={probe.get('status_code')} error={probe.get('error')}")

    hdmi = payload.get("hdmi_outputs", [])
    if hdmi:
        joined = ", ".join(f"{item.get('name')}={item.get('status')}" for item in hdmi)
        print(f"hdmi:      {joined}")
    else:
        print("hdmi:      none")

    issues = payload.get("issues", [])
    if not issues:
        print("issues:    none")
        return

    print("issues:")
    for issue in issues:
        print(f"  - [{issue.get('level')}] {issue.get('code')}: {issue.get('message')}")
        print(f"    suggestion: {issue.get('suggestion')}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check BellForge display pipeline diagnostics.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000", help="Backend base URL")
    parser.add_argument("--json", action="store_true", help="Emit raw JSON")
    parser.add_argument(
        "--self-heal",
        choices=["enable-client", "restart-client", "restart-lightdm", "reboot"],
        help="Run a display self-heal action before collecting diagnostics",
    )
    args = parser.parse_args()

    try:
        if args.self_heal:
            heal_payload = _fetch_json(f"{args.base_url.rstrip('/')}/api/display/self-heal", {"action": args.self_heal})
            print(json.dumps({"self_heal": heal_payload}, indent=2))

        payload = _fetch_json(f"{args.base_url.rstrip('/')}/api/display/pipeline")
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            _print_human(payload)

        return 0 if payload.get("health") == "ok" else 1
    except urllib.error.URLError as exc:
        print(f"display_debug: request failed: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"display_debug: unexpected error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
