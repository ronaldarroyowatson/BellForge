from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, cast


REQUIRED_CAPABILITIES = ["CAP_SYS_BOOT", "CAP_SYS_ADMIN", "CAP_NET_ADMIN"]
CAPABILITY_INDEX = {
    "CAP_CHOWN": 0,
    "CAP_DAC_OVERRIDE": 1,
    "CAP_DAC_READ_SEARCH": 2,
    "CAP_FOWNER": 3,
    "CAP_FSETID": 4,
    "CAP_KILL": 5,
    "CAP_SETGID": 6,
    "CAP_SETUID": 7,
    "CAP_SETPCAP": 8,
    "CAP_LINUX_IMMUTABLE": 9,
    "CAP_NET_BIND_SERVICE": 10,
    "CAP_NET_BROADCAST": 11,
    "CAP_NET_ADMIN": 12,
    "CAP_NET_RAW": 13,
    "CAP_IPC_LOCK": 14,
    "CAP_IPC_OWNER": 15,
    "CAP_SYS_MODULE": 16,
    "CAP_SYS_RAWIO": 17,
    "CAP_SYS_CHROOT": 18,
    "CAP_SYS_PTRACE": 19,
    "CAP_SYS_PACCT": 20,
    "CAP_SYS_ADMIN": 21,
    "CAP_SYS_BOOT": 22,
    "CAP_SYS_NICE": 23,
    "CAP_SYS_RESOURCE": 24,
    "CAP_SYS_TIME": 25,
    "CAP_SYS_TTY_CONFIG": 26,
    "CAP_MKNOD": 27,
    "CAP_LEASE": 28,
    "CAP_AUDIT_WRITE": 29,
    "CAP_AUDIT_CONTROL": 30,
    "CAP_SETFCAP": 31,
    "CAP_MAC_OVERRIDE": 32,
    "CAP_MAC_ADMIN": 33,
    "CAP_SYSLOG": 34,
    "CAP_WAKE_ALARM": 35,
    "CAP_BLOCK_SUSPEND": 36,
    "CAP_AUDIT_READ": 37,
    "CAP_PERFMON": 38,
    "CAP_BPF": 39,
    "CAP_CHECKPOINT_RESTORE": 40,
}


@dataclass(slots=True)
class PrivilegeCheckResult:
    name: str
    ok: bool
    detail: str
    recommendation: str | None = None

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
        }
        if self.recommendation:
            payload["recommendation"] = self.recommendation
        return payload


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def _effective_capabilities() -> set[str]:
    status_path = Path("/proc/self/status")
    if not status_path.is_file():
        return set()

    cap_eff_hex = ""
    for line in status_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("CapEff:"):
            cap_eff_hex = line.split(":", 1)[1].strip()
            break

    if not cap_eff_hex:
        return set()

    try:
        cap_bits = int(cap_eff_hex, 16)
    except ValueError:
        return set()

    present: set[str] = set()
    for name, bit in CAPABILITY_INDEX.items():
        if cap_bits & (1 << bit):
            present.add(name)
    return present


def check_privileges(service_name: str = "bellforge.service") -> dict[str, Any]:
    results: list[PrivilegeCheckResult] = []

    geteuid = cast(Callable[[], int] | None, getattr(os, "geteuid", None))
    euid = geteuid() if geteuid else -1
    is_root = euid == 0
    results.append(
        PrivilegeCheckResult(
            name="run-as-root",
            ok=is_root,
            detail=f"effective uid={euid}",
            recommendation=None
            if is_root
            else "Run BellForge via systemd as root (omit User/Group in unit, then restart service).",
        )
    )

    caps_present = _effective_capabilities()
    missing_caps = [cap for cap in REQUIRED_CAPABILITIES if cap not in caps_present]
    results.append(
        PrivilegeCheckResult(
            name="required-capabilities",
            ok=not missing_caps,
            detail=(
                "effective capabilities include required set"
                if not missing_caps
                else f"missing: {', '.join(missing_caps)}"
            ),
            recommendation=None
            if not missing_caps
            else "Run as root or assign capabilities to the executable with setcap.",
        )
    )

    status_result = _run(["systemctl", "status", service_name, "--no-pager"])
    results.append(
        PrivilegeCheckResult(
            name="systemctl-status",
            ok=status_result.returncode == 0,
            detail=(
                f"systemctl status succeeded for {service_name}"
                if status_result.returncode == 0
                else (status_result.stderr.strip() or status_result.stdout.strip() or "systemctl status failed")
            ),
            recommendation=None
            if status_result.returncode == 0
            else "Verify the service exists and BellForge runs with sufficient privileges.",
        )
    )

    restart_result = _run(["systemctl", "restart", service_name, "--dry-run"])
    results.append(
        PrivilegeCheckResult(
            name="systemctl-restart-dry-run",
            ok=restart_result.returncode == 0,
            detail=(
                f"systemctl restart --dry-run succeeded for {service_name}"
                if restart_result.returncode == 0
                else (restart_result.stderr.strip() or restart_result.stdout.strip() or "restart dry-run failed")
            ),
            recommendation=None
            if restart_result.returncode == 0
            else "Confirm systemd permissions and that the unit file is valid.",
        )
    )

    shutdown_result = _run(["shutdown", "-r", "now", "--dry-run"])
    results.append(
        PrivilegeCheckResult(
            name="shutdown-dry-run",
            ok=shutdown_result.returncode == 0,
            detail=(
                "shutdown dry-run succeeded"
                if shutdown_result.returncode == 0
                else (shutdown_result.stderr.strip() or shutdown_result.stdout.strip() or "shutdown dry-run failed")
            ),
            recommendation=None
            if shutdown_result.returncode == 0
            else "Ensure your distro supports shutdown --dry-run and BellForge is running as root.",
        )
    )

    var_dir = Path("/var/lib/bellforge")
    write_ok = False
    write_detail = ""
    try:
        var_dir.mkdir(parents=True, exist_ok=True)
        probe_file = var_dir / ".privilege-write-test"
        probe_file.write_text(_utc_now(), encoding="utf-8")
        probe_file.unlink(missing_ok=True)
        write_ok = True
        write_detail = "write probe succeeded in /var/lib/bellforge"
    except Exception as exc:
        write_detail = f"write failed: {exc}"

    results.append(
        PrivilegeCheckResult(
            name="var-lib-write",
            ok=write_ok,
            detail=write_detail,
            recommendation=None if write_ok else "Create /var/lib/bellforge and ensure root-owned writable permissions.",
        )
    )

    overall_ok = all(item.ok for item in results)
    return {
        "timestamp": _utc_now(),
        "overall_ok": overall_ok,
        "service": service_name,
        "results": [item.as_dict() for item in results],
    }
