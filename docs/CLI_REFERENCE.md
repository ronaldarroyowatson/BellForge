# BellForge CLI Reference

`scripts/bellforge_cli.py` is the unified diagnostics and operations tool.
It runs directly on the Pi or on any host that can reach the BellForge backend.

```
python3 /opt/bellforge/scripts/bellforge_cli.py <command> [options]
```

All commands output JSON to stdout. Exit code `0` = success/healthy, non-zero = failure or unhealthy state.

---

## Global option

`--base-url <url>` is available on every API-backed command (default: `http://127.0.0.1:8000`).  
Use this when calling the CLI from a remote machine against a non-local backend.

---

## Commands

### `triage`
Collect all major diagnostics in one structured JSON report.
Checks service states, journals, and every major API endpoint.

```bash
python3 bellforge_cli.py triage
python3 bellforge_cli.py triage --base-url http://192.168.2.180:8000
python3 bellforge_cli.py triage --save /tmp/my-report.json --journal-lines 120
```

| Option | Default | Description |
|--------|---------|-------------|
| `--base-url` | `http://127.0.0.1:8000` | Backend URL |
| `--host-label` | `local` | Label embedded in report metadata |
| `--journal-lines` | `80` | Lines of journal to capture per service |
| `--save` | `/tmp/bellforge-triage.json` | Path to write JSON report |

Exit code `0` if backend and LightDM are active and display health is `ok` or `warn`.

---

### `updater-status`
Show full updater lifecycle state: current version, staging state, last result, remote source health.

```bash
python3 bellforge_cli.py updater-status
python3 bellforge_cli.py updater-status --base-url http://192.168.2.180:8000
```

---

### `updater-check-now`
Trigger the updater to perform an immediate version check and download changed files if a newer version is available.
This is the standard way to apply a new release without waiting for the next scheduled poll.

```bash
python3 bellforge_cli.py updater-check-now
python3 bellforge_cli.py updater-check-now --base-url http://192.168.2.180:8000
```

Exit code `0` if the trigger was accepted. The updater runs asynchronously; follow up with `updater-status` to track completion.

---

### `display-status`
Show end-to-end display pipeline health: kiosk URL, service state, LightDM, HDMI outputs, and current issues.

```bash
python3 bellforge_cli.py display-status
```

Exit code `0` if display health is `ok`, `1` if degraded.

---

### `display-heal <action>`
Run a targeted display self-heal action. Falls back to local `sudo` commands if the backend lacks privilege.

```bash
python3 bellforge_cli.py display-heal restart-client
python3 bellforge_cli.py display-heal restart-lightdm
python3 bellforge_cli.py display-heal reboot
```

| Action | What it does |
|--------|-------------|
| `enable-client` | Enable and start `bellforge-client.service` |
| `restart-client` | Restart `bellforge-client.service` |
| `restart-lightdm` | Restart `lightdm.service` (recreates X session) |
| `reboot` | Reboot the Pi |
| `reset-gpu` | Trigger DRM GPU reset |
| `clear-framebuffer` | Clear framebuffer device |
| `force-hdmi-mode` | Set HDMI to 1920×1080 60Hz via xrandr |
| `cold-reboot` | Delayed reboot (2 s) for graceful shutdown scenarios |

---

### `service <name> <action>`
Inspect or control individual BellForge services and LightDM.

```bash
python3 bellforge_cli.py service backend status
python3 bellforge_cli.py service updater restart
python3 bellforge_cli.py service client stop
```

| Name | systemd unit |
|------|------------|
| `backend` | `bellforge-backend.service` |
| `client` | `bellforge-client.service` |
| `updater` | `bellforge-updater.service` |
| `lightdm` | `lightdm.service` |

| Action | Description |
|--------|-------------|
| `status` | Show `is-active` and `is-enabled` state |
| `start` | Start the unit |
| `stop` | Stop the unit |
| `restart` | Restart the unit |
| `enable` | Enable for auto-start |
| `disable` | Disable auto-start |

---

### `logs <service>`
Fetch recent log lines from the backend log API.

```bash
python3 bellforge_cli.py logs backend
python3 bellforge_cli.py logs updater --lines 500 --contains error
python3 bellforge_cli.py logs install-repair --json
```

| Service | Log source |
|---------|-----------|
| `backend` | Backend application log |
| `updater` | Updater agent log |
| `client` | Client service log |
| `install-repair` | Install/repair run log |

| Option | Default | Description |
|--------|---------|-------------|
| `--lines` | `200` | Number of lines to return |
| `--contains` | — | Filter lines containing this string |
| `--json` | off | Output full JSON payload instead of plain lines |

---

### `api <url>`
Call any JSON API endpoint directly. Useful for one-off queries and scripting.

```bash
python3 bellforge_cli.py api http://127.0.0.1:8000/health
python3 bellforge_cli.py api http://127.0.0.1:8000/api/version
python3 bellforge_cli.py api http://127.0.0.1:8000/api/updater/check-now --method POST --body '{}'
```

| Option | Default | Description |
|--------|---------|-------------|
| `--method` | `GET` | HTTP method: `GET` or `POST` |
| `--body` | — | JSON body string for POST requests |

---

## Remote usage from Windows (PowerShell)

`scripts/pi_remote_triage.ps1` wraps SSH access for running CLI commands remotely from a Windows dev machine.

```powershell
# Install/update cli on Pi and run triage report
.\scripts\pi_remote_triage.ps1 -PiHost 192.168.2.180 -InstallCli -RunTriage

# Trigger a manual update check on the Pi
.\scripts\pi_remote_triage.ps1 -PiHost 192.168.2.180 -CheckNow

# Run any arbitrary CLI command remotely
.\scripts\pi_remote_triage.ps1 -PiHost 192.168.2.180 -RemoteCommand "python3 /opt/bellforge/scripts/bellforge_cli.py updater-status"
```

---

## Standard update workflow (autoupdate verification)

Use this sequence to push a change and verify it reaches the Pi via autoupdate:

```bash
# 1. On dev machine: commit, bump version, push to main
python scripts/bump_version.py patch
git add config/version.json config/manifest.json
git commit -m "chore: release vX.Y.Z [skip ci]"
git push origin main

# 2. On Pi (or via remote triage script): trigger immediate check
python3 /opt/bellforge/scripts/bellforge_cli.py updater-check-now

# 3. Confirm update was applied
python3 /opt/bellforge/scripts/bellforge_cli.py updater-status

# 4. Full diagnostic to verify all services healthy
python3 /opt/bellforge/scripts/bellforge_cli.py triage
```

Or from Windows in one step:
```powershell
.\scripts\pi_remote_triage.ps1 -PiHost 192.168.2.180 -CheckNow
.\scripts\pi_remote_triage.ps1 -PiHost 192.168.2.180 -RunTriage
```

---

## Full bugfix rollout verification from dev machine

Use the Playwright-backed rollout verifier before closing a bugfix. It connects to the real Pi, confirms the published version is visible to the device, confirms the release is staged, reboots the Pi, waits for it to return, then validates the post-reboot Status page, Settings page, and live preview modal through a real browser.

```bash
npm run verify:pi-rollout -- --pi-host 192.168.2.180 --expected-version 0.1.54
```

Optional flags:

```bash
npm run verify:pi-rollout -- --pi-host 192.168.2.180 --expected-version 0.1.54 --ssh-key ~/.ssh/exportedRaspberryPiKey
npm run verify:pi-rollout -- --pi-host 192.168.2.180 --expected-version 0.1.54 --allow-already-current
```

Artifacts are written to `tests/logs/pi-rollout/`.

---

## Adding new commands

Follow the conventions in `docs/CODING_CONVENTIONS.md` → **CLI Conventions** section.
All new commands belong in `scripts/bellforge_cli.py`.
