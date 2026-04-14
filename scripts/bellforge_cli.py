#!/usr/bin/env python3
"""Unified BellForge diagnostics and operations CLI.

Run this on the Pi (or any host that can reach BellForge backend):
  python3 /opt/bellforge/scripts/bellforge_cli.py triage
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from privilege_doctor import check_privileges


SERVICE_UNITS = {
    "backend": "bellforge-backend.service",
    "client": "bellforge-client.service",
    "updater": "bellforge-updater.service",
    "lightdm": "lightdm.service",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None, timeout: float = 8.0) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def run_cmd(args: list[str]) -> tuple[int, str, str]:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def unit_status(unit: str) -> dict[str, Any]:
    rc_active, out_active, err_active = run_cmd(["systemctl", "is-active", unit])
    rc_enabled, out_enabled, err_enabled = run_cmd(["systemctl", "is-enabled", unit])
    return {
        "unit": unit,
        "active": out_active or "unknown",
        "enabled": out_enabled or "unknown",
        "active_rc": rc_active,
        "enabled_rc": rc_enabled,
        "active_err": err_active,
        "enabled_err": err_enabled,
    }


def unit_control(unit: str, action: str) -> dict[str, Any]:
    cmd = ["systemctl", action, unit]
    rc, out, err = run_cmd(cmd)
    return {
        "unit": unit,
        "action": action,
        "ok": rc == 0,
        "returncode": rc,
        "stdout": out,
        "stderr": err,
    }


def unit_journal(unit: str, lines: int = 80) -> dict[str, Any]:
    rc, out, err = run_cmd(["journalctl", "-u", unit, "--no-pager", "-n", str(lines)])
    return {
        "unit": unit,
        "ok": rc == 0,
        "returncode": rc,
        "text": out,
        "stderr": err,
    }


def print_json(data: dict[str, Any]) -> None:
    print(json.dumps(data, indent=2))


def cmd_api(args: argparse.Namespace) -> int:
    method = args.method.upper()
    payload = None
    if args.body:
        payload = json.loads(args.body)

    try:
        response = fetch_json(args.url, method=method, payload=payload)
        print_json(response)
        return 0
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        print(json.dumps({"error": f"HTTP {exc.code}", "body": text}, indent=2), file=sys.stderr)
        return 2
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, indent=2), file=sys.stderr)
        return 3


def cmd_service(args: argparse.Namespace) -> int:
    unit = SERVICE_UNITS[args.name]
    if args.action == "status":
        result = unit_status(unit)
        print_json(result)
        return 0 if result["active"] == "active" else 1

    result = unit_control(unit, args.action)
    result["post_status"] = unit_status(unit)
    print_json(result)
    return 0 if result["ok"] else 1


def cmd_logs(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    query = f"lines={args.lines}"
    if args.contains:
        query += f"&contains={args.contains}"

    url = f"{base}/api/logs/{args.service}?{query}"
    try:
        payload = fetch_json(url)
        if args.json:
            print_json(payload)
        else:
            print(f"service={payload.get('service')} path={payload.get('log_path')} lines={payload.get('line_count')}")
            for line in payload.get("lines", []):
                print(line)
        return 0
    except Exception as exc:
        print(f"logs failed: {exc}", file=sys.stderr)
        return 2


def cmd_updater_status(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    try:
        payload = fetch_json(f"{base}/api/updater/status")
        print_json(payload)
        return 0
    except Exception as exc:
        print(f"updater status failed: {exc}", file=sys.stderr)
        return 2


def cmd_updater_check_now(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    try:
        payload = fetch_json(f"{base}/api/updater/check-now", method="POST", payload={})
        print_json(payload)
        return 0 if payload.get("ok") else 1
    except Exception as exc:
        print(f"updater check-now failed: {exc}", file=sys.stderr)
        return 2


def cmd_display_status(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    try:
        payload = fetch_json(f"{base}/api/display/pipeline")
        print_json(payload)
        return 0 if payload.get("health") == "ok" else 1
    except Exception as exc:
        print(f"display status failed: {exc}", file=sys.stderr)
        return 2


def cmd_display_heal(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    try:
        payload = fetch_json(
            f"{base}/api/display/self-heal",
            method="POST",
            payload={"action": args.action},
        )

        if payload.get("ok"):
            print_json(payload)
            return 0

        print_json(payload)
        return 1
    except Exception as exc:
        print(f"display self-heal failed: {exc}", file=sys.stderr)
        return 2


def cmd_triage(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    report: dict[str, Any] = {
        "timestamp": utc_now(),
        "host": args.host_label,
        "services": {},
        "api": {},
        "journals": {},
    }

    units = [SERVICE_UNITS[name] for name in ("backend", "client", "updater", "lightdm")]
    for unit in units:
        report["services"][unit] = unit_status(unit)
        report["journals"][unit] = unit_journal(unit, lines=args.journal_lines)

    api_paths = {
        "health": "/health",
        "network": "/api/network/info",
        "auth": "/api/auth/status",
        "updater": "/api/updater/status",
        "display": "/api/display/pipeline",
    }

    for key, rel in api_paths.items():
        try:
            report["api"][key] = {
                "ok": True,
                "payload": fetch_json(f"{base}{rel}"),
            }
        except Exception as exc:
            report["api"][key] = {
                "ok": False,
                "error": str(exc),
            }

    if args.save:
        output_path = Path(args.save)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print_json(report)

    display_payload = report["api"].get("display", {}).get("payload", {})
    display_health = display_payload.get("health")
    service_ok = all(
        report["services"][unit].get("active") == "active"
        for unit in (SERVICE_UNITS["backend"], SERVICE_UNITS["lightdm"])
    )

    return 0 if service_ok and display_health in {"ok", "warn"} else 1


def _print_doctor_report(report: dict[str, Any]) -> None:
    print(f"Doctor report timestamp: {report.get('timestamp')}")
    print(f"Service target: {report.get('service')}")
    print()
    for item in report.get("results", []):
        status = "PASS" if item.get("ok") else "FAIL"
        print(f"[{status}] {item.get('name')}: {item.get('detail')}")
        if not item.get("ok") and item.get("recommendation"):
            print(f"  Fix: {item.get('recommendation')}")
    print()
    print(f"Overall: {'PASS' if report.get('overall_ok') else 'FAIL'}")


def cmd_doctor(args: argparse.Namespace) -> int:
    report = check_privileges(service_name=args.service)
    if args.json:
        print_json(report)
    else:
        _print_doctor_report(report)
    return 0 if report.get("overall_ok") else 1


def verify_installation(service_name: str) -> dict[str, Any]:
    doctor_report = check_privileges(service_name=service_name)
    active_rc, active_out, active_err = run_cmd(["systemctl", "is-active", service_name])
    show_rc, show_out, show_err = run_cmd(["systemctl", "show", service_name, "--property=User", "--value"])
    run_user = show_out.strip() if show_rc == 0 else ""
    runs_as_root = run_user in {"", "root"}

    summary = {
        "service": service_name,
        "doctor": doctor_report,
        "service_active": active_rc == 0 and active_out.strip() == "active",
        "service_active_detail": active_out or active_err,
        "service_run_user": run_user or "root(default)",
        "service_runs_as_root": runs_as_root,
    }
    summary["overall_ok"] = bool(
        summary["doctor"].get("overall_ok")
        and summary["service_active"]
        and summary["service_runs_as_root"]
    )
    return summary


def cmd_verify_installation(args: argparse.Namespace) -> int:
    report = verify_installation(service_name=args.service)
    print("Installation verification")
    print(f"- service active: {'PASS' if report['service_active'] else 'FAIL'} ({report['service_active_detail']})")
    print(f"- service runs as root: {'PASS' if report['service_runs_as_root'] else 'FAIL'} ({report['service_run_user']})")
    print(f"- doctor checks: {'PASS' if report['doctor']['overall_ok'] else 'FAIL'}")
    print(f"Final summary: {'SUCCESS' if report['overall_ok'] else 'FAIL'}")
    return 0 if report["overall_ok"] else 1


def cmd_agent(args: argparse.Namespace) -> int:
    project_root = Path(__file__).resolve().parents[1]
    agent_path = project_root / "updater" / "agent.py"
    if not agent_path.is_file():
        print(f"updater agent not found at {agent_path}", file=sys.stderr)
        return 2

    python_bin = Path("/opt/bellforge/.venv/bin/python")
    if not python_bin.is_file():
        python_bin = Path(sys.executable)

    os.execv(str(python_bin), [str(python_bin), str(agent_path)])
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Unified BellForge diagnostics CLI")
    parser.set_defaults(func=None)

    sub = parser.add_subparsers(dest="command")

    api = sub.add_parser("api", help="Call any JSON API endpoint")
    api.add_argument("url")
    api.add_argument("--method", default="GET", choices=["GET", "POST"])
    api.add_argument("--body", help="JSON body string for POST")
    api.set_defaults(func=cmd_api)

    service = sub.add_parser("service", help="Control BellForge/lightdm services")
    service.add_argument("name", choices=sorted(SERVICE_UNITS.keys()))
    service.add_argument("action", choices=["status", "start", "stop", "restart", "enable", "disable"])
    service.set_defaults(func=cmd_service)

    logs = sub.add_parser("logs", help="Read backend log endpoint")
    logs.add_argument("service", choices=["backend", "updater", "client", "install-repair"])
    logs.add_argument("--base-url", default="http://127.0.0.1:8000")
    logs.add_argument("--lines", type=int, default=200)
    logs.add_argument("--contains")
    logs.add_argument("--json", action="store_true")
    logs.set_defaults(func=cmd_logs)

    ups = sub.add_parser("updater-status", help="Show updater lifecycle status")
    ups.add_argument("--base-url", default="http://127.0.0.1:8000")
    ups.set_defaults(func=cmd_updater_status)

    upn = sub.add_parser("updater-check-now", help="Trigger updater manual check-now endpoint")
    upn.add_argument("--base-url", default="http://127.0.0.1:8000")
    upn.set_defaults(func=cmd_updater_check_now)

    dsp = sub.add_parser("display-status", help="Show display pipeline payload")
    dsp.add_argument("--base-url", default="http://127.0.0.1:8000")
    dsp.set_defaults(func=cmd_display_status)

    dsh = sub.add_parser("display-heal", help="Run display self-heal action")
    dsh.add_argument(
        "action",
        choices=[
            "enable-client",
            "restart-client",
            "restart-lightdm",
            "reboot",
            "reset-gpu",
            "clear-framebuffer",
            "force-hdmi-mode",
            "cold-reboot",
        ],
    )
    dsh.add_argument("--base-url", default="http://127.0.0.1:8000")
    dsh.set_defaults(func=cmd_display_heal)

    triage = sub.add_parser("triage", help="Collect all major diagnostics in one report")
    triage.add_argument("--base-url", default="http://127.0.0.1:8000")
    triage.add_argument("--host-label", default="local")
    triage.add_argument("--journal-lines", type=int, default=80)
    triage.add_argument("--save", default="/tmp/bellforge-triage.json")
    triage.set_defaults(func=cmd_triage)

    doctor = sub.add_parser("doctor", help="Run privilege diagnostics for root/systemd operations")
    doctor.add_argument("--service", default="bellforge.service")
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(func=cmd_doctor)

    verify = sub.add_parser("verify-installation", help="Verify service/root install state")
    verify.add_argument("--service", default="bellforge.service")
    verify.set_defaults(func=cmd_verify_installation)

    agent = sub.add_parser("agent", help="Run the BellForge updater agent process")
    agent.set_defaults(func=cmd_agent)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not getattr(args, "func", None):
        parser.print_help()
        return 1

    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
