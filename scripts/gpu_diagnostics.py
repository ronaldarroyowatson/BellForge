#!/usr/bin/env python3
"""
Detailed GPU and Display Diagnostics for Raspberry Pi
Collects in-depth hardware/driver state to diagnose display corruption issues.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def run_cmd(cmd: list[str], timeout: int = 5) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"
    except Exception as e:
        return -1, "", str(e)


def collect_boot_timeline() -> dict[str, Any]:
    """Analyze boot timeline to detect timing issues."""
    result = {
        "uptime_seconds": 0,
        "services_startup_times": {},
        "dmesg_gpu_events": [],
    }

    # Get uptime
    try:
        with open("/proc/uptime", "r") as f:
            uptime = float(f.read().split()[0])
            result["uptime_seconds"] = int(uptime)
    except Exception as e:
        result["uptime_seconds"] = -1

    # Parse systemd timing
    rc, out, _ = run_cmd(["systemd-analyze"])
    if rc == 0:
        for line in out.splitlines():
            if "lightdm" in line or "bellforge-client" in line:
                result["services_startup_times"][line.split()[0]] = line

    # Look for GPU-related events in dmesg
    rc, out, _ = run_cmd(["dmesg"])
    if rc == 0:
        for line in out.splitlines():
            if re.search(r"gpu|gfx|drm|hdmi|vc4|v3d", line, re.IGNORECASE):
                result["dmesg_gpu_events"].append(line)

    return result


def collect_gpu_device_info() -> dict[str, Any]:
    """Collect GPU device info."""
    result = {
        "pci_devices": [],
        "drm_devices": [],
        "gpu_device_tree": [],
    }

    # PCI devices
    rc, out, _ = run_cmd(["lspci", "-v"])
    if rc == 0:
        for line in out.splitlines():
            if re.search(r"vga|3d|display|gpu", line, re.IGNORECASE):
                result["pci_devices"].append(line)

    # DRM devices
    drm_path = Path("/sys/class/drm")
    if drm_path.exists():
        for device in drm_path.glob("card*"):
            result["drm_devices"].append(device.name)

    # Device tree GPU entries (RPi specific)
    dt_gpu_path = Path("/proc/device-tree")
    if dt_gpu_path.exists():
        for gpu_path in dt_gpu_path.glob("*gpu*"):
            result["gpu_device_tree"].append(gpu_path.name)

    return result


def collect_display_mode_info() -> dict[str, Any]:
    """Collect current display mode and EDID information."""
    result = {
        "xrandr_displays": [],
        "hdmi_edid": None,
        "hdmi_status": [],
        "current_resolution": None,
        "display_clock": None,
    }

    # xrandr info
    env = os.environ.copy()
    env["DISPLAY"] = ":0"
    rc, out, _ = run_cmd(["xrandr"], timeout=3)
    if rc == 0:
        result["xrandr_displays"] = out.splitlines()

        # Try to extract current resolution
        for line in out.splitlines():
            if " connected" in line and "x" in line:
                parts = line.split()
                for part in parts:
                    if re.match(r"\d+x\d+", part):
                        result["current_resolution"] = part
                        break

    # HDMI EDID
    for edid_path in Path("/sys/class/drm").glob("card*-HDMI-A-*/edid"):
        try:
            edid_raw = edid_path.read_bytes()
            result["hdmi_edid"] = {
                "size": len(edid_raw),
                "first_bytes": edid_raw[:16].hex() if edid_raw else "",
            }
        except Exception:
            pass

    # HDMI status
    for status_path in Path("/sys/class/drm").glob("card*-HDMI-A-*/status"):
        try:
            status = status_path.read_text(encoding="utf-8").strip()
            result["hdmi_status"].append({
                "device": status_path.parent.name,
                "status": status,
            })
        except Exception:
            pass

    return result


def collect_framebuffer_info() -> dict[str, Any]:
    """Collect framebuffer configuration and state."""
    result = {
        "fb_device_exists": False,
        "fb_readable": False,
        "fb_writable": False,
        "fbset_info": {},
        "fb_memory_map": None,
    }

    fb_path = Path("/dev/fb0")
    result["fb_device_exists"] = fb_path.exists()

    if fb_path.exists():
        result["fb_readable"] = os.access(str(fb_path), os.R_OK)
        result["fb_writable"] = os.access(str(fb_path), os.W_OK)

        # Get framebuffer info via fbset
        rc, out, err = run_cmd(["fbset", "-i"])
        if rc == 0:
            result["fbset_info"] = {
                "output": out,
                "error": None,
            }
        else:
            result["fbset_info"] = {
                "output": "",
                "error": err,
            }

        # Try to read /proc/filesystems to see if FB driver loaded
        try:
            with open("/proc/fb", "r") as f:
                result["fb_memory_map"] = f.read()
        except Exception:
            pass

    return result


def collect_gpu_memory_info() -> dict[str, Any]:
    """Collect GPU memory allocation and pressure."""
    result = {
        "system_memory": {},
        "gpu_memory_split": {},
        "memory_pressure": 0,
        "swap_usage": {},
        "gpu_mem_allocation": None,
    }

    # System memory
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                key, val = line.split(":", 1)
                if key.strip() in ["MemTotal", "MemAvailable", "MemFree", "Cached"]:
                    result["system_memory"][key.strip()] = int(val.split()[0])
    except Exception as e:
        result["system_memory"]["error"] = str(e)

    # GPU memory split (RPi specific)
    try:
        gpu_mem = Path("/sys/module/vc4/parameters/gpu_mem")
        if gpu_mem.exists():
            result["gpu_memory_split"]["gpu_mem"] = int(gpu_mem.read_text().strip())
    except Exception:
        pass

    # Memory pressure
    if "MemTotal" in result["system_memory"] and "MemAvailable" in result["system_memory"]:
        mem_total = result["system_memory"]["MemTotal"]
        mem_avail = result["system_memory"]["MemAvailable"]
        if mem_total > 0:
            result["memory_pressure"] = 100 * (1 - mem_avail / mem_total)

    # Swap
    try:
        with open("/proc/swaps", "r") as f:
            lines = f.readlines()
            if len(lines) > 1:
                parts = lines[1].split()
                result["swap_usage"] = {
                    "total": int(parts[2]),
                    "used": int(parts[3]),
                }
    except Exception:
        pass

    # Check /proc/abrms for GPU allocation (RPi VideoCore IV)
    try:
        with open("/proc/abrms", "r") as f:
            result["gpu_mem_allocation"] = f.read()
    except Exception:
        pass

    return result


def collect_thermal_info() -> dict[str, Any]:
    """Collect thermal state."""
    result = {
        "thermal_zones": [],
        "current_temp_celsius": None,
        "thermal_throttle_warning": False,
    }

    thermal_path = Path("/sys/class/thermal/thermal_zone0")
    if thermal_path.exists():
        try:
            temp_mk = int((thermal_path / "temp").read_text().strip())
            temp_c = temp_mk / 1000
            result["current_temp_celsius"] = temp_c

            if temp_c > 85:
                result["thermal_throttle_warning"] = True
        except Exception:
            pass

    # Collect all thermal zones
    thermal_class = Path("/sys/class/thermal")
    if thermal_class.exists():
        for zone in thermal_class.glob("thermal_zone*"):
            try:
                temp = int((zone / "temp").read_text().strip())
                result["thermal_zones"].append({
                    "name": zone.name,
                    "temp_celsius": temp / 1000,
                })
            except Exception:
                pass

    return result


def collect_x_server_info() -> dict[str, Any]:
    """Collect X server status."""
    result = {
        "x_socket_exists": False,
        "x_responsiveness": "unknown",
        "x_processes": [],
        "display_var": None,
    }

    result["x_socket_exists"] = Path("/tmp/.X11-unix/X0").exists()
    result["display_var"] = os.environ.get("DISPLAY", "unset")

    # Try xdpyinfo
    rc, out, err = run_cmd(["xdpyinfo"], timeout=2)
    if rc == 0:
        result["x_responsiveness"] = "responsive"
    else:
        result["x_responsiveness"] = f"unresponsive (rc={rc})"

    # Find X processes
    rc, ps_out, _ = run_cmd(["ps", "aux"])
    if rc == 0:
        for line in ps_out.splitlines():
            if "Xvfb" in line or "Xwayland" in line or re.search(r'X\s', line):
                result["x_processes"].append(line.split(None, 3)[3])

    return result


def collect_chromium_info() -> dict[str, Any]:
    """Collect Chromium process info."""
    result = {
        "processes": [],
        "memory_usage_kb": 0,
        "cpu_usage_percent": 0.0,
    }

    rc, ps_out, _ = run_cmd(["ps", "aux"])
    if rc == 0:
        total_mem = 0
        total_cpu = 0.0
        count = 0

        for line in ps_out.splitlines():
            if "chromium" in line.lower():
                parts = line.split()
                if len(parts) >= 6:
                    result["processes"].append(line.strip())
                    try:
                        total_mem += int(parts[5])
                        total_cpu += float(parts[2])
                        count += 1
                    except (ValueError, IndexError):
                        pass

        if count > 0:
            result["memory_usage_kb"] = total_mem
            result["cpu_usage_percent"] = total_cpu

    return result


def collect_kernel_module_info() -> dict[str, Any]:
    """Check loaded GPU-related kernel modules."""
    result = {
        "loaded_modules": [],
        "modules_with_parameters": {},
    }

    try:
        with open("/proc/modules", "r") as f:
            for line in f:
                module = line.split()[0]
                if re.search(r"vc4|v3d|drm|gpu", module, re.IGNORECASE):
                    result["loaded_modules"].append(module)

                    # Get module parameters
                    params_path = Path(f"/sys/module/{module}/parameters")
                    if params_path.exists():
                        params = {}
                        for param_file in params_path.glob("*"):
                            try:
                                params[param_file.name] = param_file.read_text(encoding="utf-8").strip()
                            except Exception:
                                pass
                        if params:
                            result["modules_with_parameters"][module] = params
    except Exception:
        pass

    return result


def collect_service_health() -> dict[str, Any]:
    """Check health of BellForge services."""
    result = {
        "services": {},
    }

    services = [
        "lightdm",
        "bellforge-backend",
        "bellforge-client",
        "bellforge-updater",
    ]

    for service in services:
        rc_active, active, _ = run_cmd(["systemctl", "is-active", service])
        rc_enabled, enabled, _ = run_cmd(["systemctl", "is-enabled", service])

        result["services"][service] = {
            "active": active.strip(),
            "enabled": enabled.strip(),
        }

    return result


def main():
    """Collect all diagnostics and output as JSON."""
    timestamp = datetime.now(timezone.utc).isoformat()

    diagnostics = {
        "timestamp": timestamp,
        "hostname": subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip(),
        "boot_timeline": collect_boot_timeline(),
        "gpu_devices": collect_gpu_device_info(),
        "display_mode": collect_display_mode_info(),
        "framebuffer": collect_framebuffer_info(),
        "gpu_memory": collect_gpu_memory_info(),
        "thermal": collect_thermal_info(),
        "x_server": collect_x_server_info(),
        "chromium": collect_chromium_info(),
        "kernel_modules": collect_kernel_module_info(),
        "services": collect_service_health(),
    }

    # Output as JSON
    print(json.dumps(diagnostics, indent=2, default=str))

    # Also save to file if running as root
    if os.geteuid() == 0:
        output_path = Path("/tmp/bellforge-gpu-diagnostics.json")
        try:
            output_path.write_text(json.dumps(diagnostics, indent=2, default=str))
            print(f"\n# Saved to: {output_path}", file=sys.stderr)
        except Exception as e:
            print(f"# Failed to save: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
