# Install Dependency Notes

This file tracks dependency issues discovered during live install testing on fresh Raspberry Pi images.

## 2026-03-31 - Raspberry Pi OS trixie (aarch64)

Environment:
- Host: 192.168.2.206
- OS: Debian trixie (Raspberry Pi OS)
- Kernel: 6.12.47+rpt-rpi-2712

Observed issue:
- `apt-get install chromium-browser` failed with:
  - `Package chromium-browser is not available`
  - `E: Package 'chromium-browser' has no installation candidate`

Root cause:
- On this image, `chromium-browser` metadata exists but has `Candidate: (none)`.
- Installable browser package is `chromium`.

Installer changes made:
- `install.sh`: chooses `chromium` when `chromium-browser` has no candidate.
- `scripts/bootstrap.sh`: same fallback logic.
- `scripts/repair.sh`: same fallback logic.
- `scripts/bellforge-client.service`: launches either `chromium-browser` or `chromium`.

Recommendation:
- Keep browser package selection dynamic by candidate availability.
- Avoid hard-coding `chromium-browser` in installer logic.

## 2026-03-31 - Additional live test findings

Observed issue:
- Repeated install in test harness failed due git ownership/safe-directory checks.

Root cause:
- Installer synced an existing repo in `/opt/bellforge` as root while ownership was `bellforge`.
- Test harness uses local-path repo source (`/home/pi/BellForge`) that triggers git safe-directory checks when accessed by another user.

Installer changes made:
- `install.sh`: git fetch/checkout/reset now run as `bellforge` service user.
- `install.sh`: local-path repo URL is registered as `safe.directory` for service user.
- `install.sh`: pre-creates `/opt/bellforge` with `bellforge` ownership before service-user clone.

Observed issue:
- Repair test intentionally removed `.venv/bin/pip`; repair script failed before reinstalling dependencies.

Repair changes made:
- `scripts/repair.sh`: if `.venv/bin/pip` is missing, run `python -m ensurepip --upgrade` before pip install steps.

Installer changes made:
- `install.sh`: same `ensurepip` recovery when `.venv/bin/pip` is missing.

Additional robustness update:
- `install.sh` and `scripts/repair.sh` now use `python -m pip` for package installs, avoiding dependence on the `pip` launcher file existing in `.venv/bin/`.

Observed issue:
- `bellforge-updater.service` exited with `PermissionError` for `/var/log/bellforge-updater.log`.

Fixes made:
- `install.sh`: creates `/var/log/bellforge-updater.log` and sets owner `bellforge:bellforge`.
- `scripts/repair.sh`: validates the same log target and ownership.
