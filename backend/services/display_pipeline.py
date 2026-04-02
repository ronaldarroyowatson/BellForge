from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx


DiagnosticLevel = Literal["ok", "warn", "error"]
SelfHealAction = Literal[
    "enable-client",
    "restart-client",
    "restart-lightdm",
    "reboot",
    "reset-gpu",
    "clear-framebuffer",
    "force-hdmi-mode",
    "cold-reboot",
]


SERVICE_MAP = {
    "backend": "bellforge-backend.service",
    "client": "bellforge-client.service",
    "updater": "bellforge-updater.service",
    "display_manager": "lightdm.service",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _service_state(service_name: str) -> dict[str, str | bool]:
    active = "unknown"
    enabled = "unknown"
    service_manager_ok = True

    try:
        active_cmd = subprocess.run(
            ["systemctl", "is-active", service_name],
            capture_output=True,
            text=True,
            check=False,
        )
        active = active_cmd.stdout.strip() or "unknown"
    except Exception:
        active = "unknown"
        service_manager_ok = False

    try:
        enabled_cmd = subprocess.run(
            ["systemctl", "is-enabled", service_name],
            capture_output=True,
            text=True,
            check=False,
        )
        enabled = enabled_cmd.stdout.strip() or "unknown"
    except Exception:
        enabled = "unknown"
        service_manager_ok = False

    return {
        "active": active,
        "enabled": enabled,
        "service_manager_ok": service_manager_ok,
        "is_active": active == "active",
        "is_enabled": enabled == "enabled",
    }


def _read_client_env(project_root: Path) -> dict[str, str]:
    env_path = project_root / "config" / "client.env"
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values

    for line in env_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        values[key.strip()] = value.strip()

    return values


def _read_version(project_root: Path) -> str | None:
    version_path = project_root / "config" / "version.json"
    if not version_path.is_file():
        return None
    try:
        return json.loads(version_path.read_text(encoding="utf-8")).get("version")
    except Exception:
        return None


def _hdmi_outputs() -> list[dict[str, str]]:
    outputs: list[dict[str, str]] = []
    for path in sorted(Path("/sys/class/drm").glob("card*-HDMI-A-*/status")):
        try:
            # Use timeout to prevent blocking on sysfs reads (some drivers block indefinitely)
            result = subprocess.run(
                ["timeout", "1", "cat", str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                status = result.stdout.strip()
            elif result.returncode == 124:  # timeout exit code
                status = "timeout"
            else:
                status = "unknown"
        except Exception:
            status = "unknown"
        outputs.append({
            "name": path.parent.name,
            "status": status,
        })
    return outputs


def _gpu_diagnostics() -> dict[str, Any]:
    """Collect GPU driver and memory diagnostics."""
    result: dict[str, Any] = {
        "driver_loaded": False,
        "gpu_devices": [],
        "memory_pressure": None,
        "gpu_busy": None,
        "powerman_status": None,
        "thermal_status": None,
        "errors": [],
    }
    
    # Check if VC4 (VideoCore IV) or V3D driver is loaded
    try:
        lspci = subprocess.run(
            ["lspci"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if "VGA" in lspci.stdout or "Display" in lspci.stdout:
            result["driver_loaded"] = True
    except Exception as e:
        result["errors"].append(f"lspci check failed: {e}")
    
    # Parse /proc/device-tree for GPU info on RPi
    try:
        for path in Path("/proc/device-tree").glob("*gpu*"):
            if path.is_dir():
                result["gpu_devices"].append(path.name)
    except Exception as e:
        result["errors"].append(f"GPU device tree check failed: {e}")
    
    # Check GPU memory pressure
    try:
        meminfo = Path("/proc/meminfo").read_text(encoding="utf-8")
        for line in meminfo.splitlines():
            if "MemAvailable" in line:
                available_bytes = int(line.split()[-2]) * 1024
                total_bytes = 0
                for line2 in meminfo.splitlines():
                    if "MemTotal" in line2:
                        total_bytes = int(line2.split()[-2]) * 1024
                if total_bytes > 0:
                    result["memory_pressure"] = 100 * (1 - available_bytes / total_bytes)
                break
    except Exception as e:
        result["errors"].append(f"Memory check failed: {e}")
    
    # Check GPU frequency (if available)
    try:
        gpu_freq_path = Path("/sys/devices/virtual/thermal/cooling_device0/cur_state")
        if gpu_freq_path.exists():
            result["gpu_busy"] = gpu_freq_path.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    
    # Check power management status
    try:
        pm_result = subprocess.run(
            ["cat", "/sys/module/powermanagement/parameters/pm_test_point"],
            capture_output=True,
            text=True,
            check=False,
            timeout=2,
        )
        if pm_result.returncode == 0:
            result["powerman_status"] = pm_result.stdout.strip()
    except Exception:
        pass
    
    # Check thermal throttling
    try:
        thermal_zone = Path("/sys/class/thermal/thermal_zone0/temp")
        if thermal_zone.exists():
            temp_mk = int(thermal_zone.read_text(encoding="utf-8").strip())
            result["thermal_status"] = {"temp_celsius": temp_mk / 1000}
            if temp_mk > 80000:
                result["errors"].append("GPU thermal throttling likely (>80°C)")
    except Exception:
        pass
    
    return result


def _display_mode_info() -> dict[str, Any]:
    """Get current display mode and resolution from DRM."""
    result: dict[str, Any] = {
        "xrandr_output": None,
        "drm_modes": [],
        "x_display_var": None,
        "x_socket_connected": False,
        "errors": [],
    }
    
    # Read init environment safely; /proc/1 is a directory and cannot be read directly.
    environ_path = Path("/proc/1/environ")
    if environ_path.exists() and environ_path.is_file():
        try:
            raw = environ_path.read_bytes().replace(b"\x00", b"\n").decode("utf-8", errors="ignore")
            result["x_display_var"] = next(
                (line for line in raw.splitlines() if line.startswith("DISPLAY=")),
                None,
            )
        except (PermissionError, IsADirectoryError):
            # Some systems restrict /proc access (e.g. hidepid); not a pipeline failure.
            result["x_display_var"] = None
        except Exception as e:
            result["errors"].append(f"init environ check failed: {e}")
    
    # Try xrandr if X is running
    try:
        xrandr_result = subprocess.run(
            ["xrandr"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
            env={**subprocess.os.environ, "DISPLAY": ":0"},
        )
        if xrandr_result.returncode == 0:
            result["xrandr_output"] = xrandr_result.stdout
        else:
            result["errors"].append(f"xrandr failed: {xrandr_result.stderr}")
    except Exception as e:
        result["errors"].append(f"xrandr check failed: {e}")
    
    # Check DRM mode info
    try:
        for path in Path("/sys/class/drm").glob("card*-HDMI-A-*/modes"):
            if path.exists():
                modes = path.read_text(encoding="utf-8").strip().splitlines()
                result["drm_modes"].extend(modes)
    except Exception as e:
        result["errors"].append(f"DRM mode check failed: {e}")
    
    # Check X socket
    if Path("/tmp/.X11-unix/X0").exists():
        result["x_socket_connected"] = True
    
    return result


def _framebuffer_integrity() -> dict[str, Any]:
    """Check framebuffer for corruption indicators."""
    result: dict[str, Any] = {
        "fb_device": None,
        "fb_size": None,
        "fb_colormap": None,
        "errors": [],
    }
    
    try:
        fb_path = Path("/dev/fb0")
        if fb_path.exists():
            result["fb_device"] = "present"
            # Get framebuffer size via ioctl-like check
            try:
                fb_var = subprocess.run(
                    ["fbset", "-i"],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=3,
                )
                if fb_var.returncode == 0:
                    result["fb_colormap"] = fb_var.stdout
            except Exception:
                pass
    except Exception as e:
        result["errors"].append(f"Framebuffer check failed: {e}")
    
    return result


async def _http_probe(url: str, timeout: float = 1.8) -> dict[str, Any]:
    result: dict[str, Any] = {
        "url": url,
        "ok": False,
        "status_code": None,
        "error": None,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            result["status_code"] = response.status_code
            result["ok"] = 200 <= response.status_code < 300
    except Exception as exc:
        result["error"] = str(exc)

    return result


def _issue(level: DiagnosticLevel, code: str, message: str, suggestion: str) -> dict[str, str]:
    return {
        "level": level,
        "code": code,
        "message": message,
        "suggestion": suggestion,
    }


async def collect_display_pipeline(project_root: Path) -> dict[str, Any]:
    env_values = _read_client_env(project_root)
    kiosk_url = env_values.get("BELLFORGE_KIOSK_URL", "http://127.0.0.1:8000/client/index.html")

    services = {
        key: _service_state(name) for key, name in SERVICE_MAP.items()
    }

    probes = {
        "backend_health": await _http_probe("http://127.0.0.1:8000/health"),
        "kiosk_url": await _http_probe(kiosk_url),
        "status_url": await _http_probe("http://127.0.0.1:8000/status"),
    }

    hdmi = _hdmi_outputs()
    gpu_diag = _gpu_diagnostics()
    display_mode = _display_mode_info()
    framebuffer = _framebuffer_integrity()
    
    issues: list[dict[str, str]] = []

    client_enabled_known = services["client"]["enabled"] != "unknown"
    client_active_known = services["client"]["active"] != "unknown"

    if client_enabled_known and not services["client"]["is_enabled"]:
        issues.append(_issue(
            "error",
            "client_service_disabled",
            "bellforge-client.service is disabled and will not survive reboot.",
            "Enable the client service or run self-heal action 'enable-client'.",
        ))

    if client_active_known and not services["client"]["is_active"]:
        issues.append(_issue(
            "error",
            "client_service_inactive",
            "bellforge-client.service is not active.",
            "Restart the client service or run self-heal action 'restart-client'.",
        ))

    if not probes["backend_health"]["ok"]:
        issues.append(_issue(
            "error",
            "backend_unreachable",
            "Backend health endpoint is not reachable on localhost.",
            "Check bellforge-backend.service logs and restart the backend service.",
        ))

    if not probes["kiosk_url"]["ok"]:
        issues.append(_issue(
            "error",
            "kiosk_target_unreachable",
            "Configured kiosk URL did not return a successful response.",
            "Verify BELLFORGE_KIOSK_URL and confirm the route exists.",
        ))

    if hdmi and not any(item["status"] == "connected" for item in hdmi):
        issues.append(_issue(
            "warn",
            "hdmi_disconnected",
            "No connected HDMI output detected.",
            "Check cable/TV input, then consider restarting lightdm.",
        ))
    
    # GPU diagnostics issues
    if gpu_diag["errors"]:
        for error in gpu_diag["errors"]:
            if "thermal" in error.lower():
                issues.append(_issue(
                    "error",
                    "gpu_thermal_throttle",
                    error,
                    "Allow system to cool down; check ventilation.",
                ))
    
    if gpu_diag["memory_pressure"] and gpu_diag["memory_pressure"] > 85:
        issues.append(_issue(
            "warn",
            "high_memory_pressure",
            f"Memory pressure {gpu_diag['memory_pressure']:.1f}%",
            "Restart services to clear memory leaks or reboot.",
        ))
    
    # Display mode issues
    if not display_mode["x_socket_connected"]:
        issues.append(_issue(
            "error",
            "x_display_not_ready",
            "X display socket not found; X server may not be running.",
            "Restart lightdm service.",
        ))
    
    if display_mode["errors"]:
        for error in display_mode["errors"]:
            issues.append(_issue(
                "warn",
                "display_mode_detection_failed",
                f"Could not detect display mode: {error}",
                "Verify DISPLAY variable and X server status.",
            ))

    health: DiagnosticLevel = "ok"
    if any(item["level"] == "error" for item in issues):
        health = "error"
    elif issues:
        health = "warn"

    return {
        "timestamp": _utc_now(),
        "health": health,
        "version": _read_version(project_root),
        "kiosk_url": kiosk_url,
        "services": services,
        "http_probes": probes,
        "hdmi_outputs": hdmi,
        "gpu_diagnostics": gpu_diag,
        "display_mode": display_mode,
        "framebuffer": framebuffer,
        "issues": issues,
        "suggested_actions": [
            "enable-client",
            "restart-client",
            "restart-lightdm",
            "reboot",
        ],
    }


def run_self_heal(action: SelfHealAction) -> dict[str, Any]:
    command_map: dict[SelfHealAction, list[str]] = {
        "enable-client": ["systemctl", "enable", "--now", "bellforge-client.service"],
        "restart-client": ["systemctl", "restart", "bellforge-client.service"],
        "restart-lightdm": ["systemctl", "restart", "lightdm.service"],
        "reboot": ["/sbin/reboot"],
        "reset-gpu": ["sh", "-c", "echo 1 > /sys/class/drm/*/reset 2>/dev/null || true"],
        "clear-framebuffer": ["sh", "-c", "fbset -c 16 2>/dev/null || true"],
        "force-hdmi-mode": ["sh", "-c", "xrandr --output HDMI-1 --mode 1920x1080 --rate 60 2>/dev/null || true && systemctl restart lightdm"],
        "cold-reboot": ["/bin/sh", "-c", "sleep 2 && /sbin/reboot"],
    }

    privileged_actions: set[SelfHealAction] = {
        "enable-client",
        "restart-client",
        "restart-lightdm",
        "reboot",
        "reset-gpu",
        "clear-framebuffer",
        "force-hdmi-mode",
        "cold-reboot",
    }

    def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(cmd, capture_output=True, text=True, check=False)

    cmd = command_map[action]
    result = _run(cmd)
    used_sudo = False

    # Services run as user bellforge, so actions that touch systemd/reboot/GPU
    # often require sudo privileges.
    current_euid = os.geteuid() if hasattr(os, "geteuid") else -1

    if action in privileged_actions and result.returncode != 0 and current_euid != 0 and shutil.which("sudo"):
        sudo_result = _run(["sudo", "-n", *cmd])
        used_sudo = True
        if sudo_result.returncode == 0:
            result = sudo_result
        else:
            combined_stderr = "\n".join(
                part for part in [result.stderr.strip(), sudo_result.stderr.strip()] if part
            )
            combined_stdout = "\n".join(
                part for part in [result.stdout.strip(), sudo_result.stdout.strip()] if part
            )
            result = subprocess.CompletedProcess(
                args=["sudo", "-n", *cmd],
                returncode=sudo_result.returncode,
                stdout=combined_stdout,
                stderr=combined_stderr,
            )

    stderr = result.stderr.strip()
    permission_denied = (
        action in privileged_actions
        and result.returncode != 0
        and (
            "permission denied" in stderr.lower()
            or "interactive authentication required" in stderr.lower()
            or "a terminal is required to read the password" in stderr.lower()
            or "sudo:" in stderr.lower()
        )
    )

    if permission_denied and not stderr:
        stderr = "Insufficient privileges for this action. Configure passwordless sudo for bellforge service user."

    return {
        "timestamp": _utc_now(),
        "action": action,
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": stderr,
        "used_sudo": used_sudo,
        "permission_denied": permission_denied,
    }
