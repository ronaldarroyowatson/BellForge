# BellForge Architecture

## 1. High-Level System Overview

BellForge is a distributed signage system with one central source of truth (repository + backend) and many Raspberry Pi devices running a kiosk client and updater.

High-level topology:

```text
                         +------------------------------+
                         | GitHub Repository            |
                         | - source code               |
                         | - config/version.json       |
                         | - config/manifest.json      |
                         +--------------+---------------+
                                        |
                                        | release/update content
                                        v
                         +------------------------------+
                         | BellForge Backend (FastAPI)  |
                         | - /health                    |
                         | - /api/version, /api/manifest|
                         | - /api/files/*, /api/schedule|
                         | - /api/broadcast             |
                         +--------------+---------------+
                                        |
                                        | poll + fetch changed files
                                        v
                    +----------------------------------------------+
                    | Raspberry Pi Device(s)                      |
                    | - updater/agent.py (systemd service)        |
                    | - client (Chromium kiosk display)           |
                    | - local config + staged update directories  |
                    +----------------------------------------------+
```

Note:
- Current codebase also includes root-level compatibility endpoints (`/version`, `/manifest`, `/file/...`) in `backend/main.py`.
- The updater currently reads from `update_base_url` and fetches `config/version.json` + `config/manifest.json` directly.

## 2. Component Breakdown

### 2.1 `backend/`
- FastAPI application and routes.
- Responsibilities:
  - health checks,
  - version/manifest/schedule APIs,
  - selective file serving,
  - optional display payload hosting,
  - broadcast trigger orchestration.

### 2.2 `client/`
- Static web client for signage rendering.
- Responsibilities:
  - render current time/period/countdown,
  - poll backend schedule/version,
  - display online/offline status gracefully.

### 2.3 `updater/`
- Python async update agent.
- Responsibilities:
  - poll for updates,
  - detect file drift via manifest hash comparison,
  - stage changed files,
  - perform managed-root atomic swap with rollback,
  - restart services or reboot based on policy.

### 2.4 `scripts/`
- Installation and lifecycle scripts plus service units.
- Responsibilities:
  - bootstrap/fresh provisioning,
  - install/repair/uninstall operations,
  - manifest generation and version bumping,
  - release preparation checks,
  - systemd service definitions.

### 2.5 `config/`
- Canonical runtime and update metadata.
- Files of interest:
  - `version.json`: semantic version and release flags.
  - `manifest.json`: SHA-256 + size map of deployable files.
  - `schedule.json`: school schedule payload.
  - `settings.template.json`: per-device settings template.

### 2.6 `tests/`
- Shell-based operational verification.
- Responsibilities:
  - install flow validation,
  - repair flow resilience checks,
  - uninstall cleanup validation,
  - smoke/system health and manifest parity checks.

## 3. Data Flow Diagrams

### 3.1 Install Flow

```text
User/IT runs install.sh
   |
   v
Install prerequisites + create service user
   |
   v
Clone/sync repo into /opt/bellforge
   |
   v
Create/refresh venv + install backend/updater deps
   |
   v
Write local config (settings.json, client.env)
   |
   v
Install systemd units + enable + start
   |
   v
BellForge operational
```

### 3.2 Update Flow

```text
updater/agent.py poll loop
   |
   v
Fetch config/version.json + config/manifest.json
   |
   v
Compare local version + file hashes
   |
   +--> no changes -> sleep until next interval
   |
   v
Download only changed files to staging release dir
   |
   v
Verify hashes -> build shadow tree -> remove stale tracked files
   |
   v
Atomic root swap (+ rollback on failure)
   |
   v
Write local version/manifest -> restart services or reboot
```

### 3.3 Repair Flow

```text
repair.sh
   |
   v
Validate directory structure + dependencies + chromium
   |
   v
Recreate venv/dependencies and missing config placeholders
   |
   v
Optional manifest-based integrity restore from update_base_url
   |
   v
Reinstall systemd services + restart BellForge services
```

### 3.4 Display Content Flow

```text
Chromium kiosk launches display URL
   |
   v
client/index.html + client/js/main.js
   |
   v
Fetch /api/schedule and /api/version periodically
   |
   v
Render current period + countdown + upcoming periods
   |
   v
Fallback to last in-memory state on transient network errors
```

## 4. Update Architecture

Core artifacts:
- `config/version.json`
  - canonical release version,
  - optional release flags (`reboot_required`, notes).
- `config/manifest.json`
  - hash-indexed deployable files,
  - used for drift detection and selective downloads.

Key mechanics:
- Selective file downloads:
  - only paths whose hashes differ are fetched.
- Atomic staging:
  - changed files are staged,
  - a shadow tree is assembled,
  - managed roots are swapped with rollback support.
- Relaunch behavior:
  - configured systemd services are restarted,
  - optional full reboot is honored when requested.

## 5. systemd Service Architecture

Primary service units:
- `bellforge-backend.service`
  - runs uvicorn app (`backend.main:app`).
- `bellforge-client.service`
  - launches Chromium in kiosk mode.
- `bellforge-updater.service`
  - runs `updater/agent.py` poll loop.
- `bellforge-file-server.service`
  - optional static file server for local client content.

Service model:
- all services run under the `bellforge` user,
- restart policies set for self-healing,
- logs routed through systemd journal (plus updater log file).

## 6. Pi Bootstrap Architecture

Bootstrap goals:
- install all runtime dependencies,
- establish `bellforge` system user,
- place runtime config under `/opt/bellforge/config`,
- enable unattended startup in kiosk mode,
- register and start required services.

Bootstrap is designed for fresh device provisioning, while `install.sh`/`repair.sh` cover ongoing lifecycle management.

## 7. Test Suite Architecture

Test stack (`tests/`):
- `run_all_tests.sh`: orchestrates install -> repair -> uninstall tests.
- `test_install.sh`: validates install artifacts and active services.
- `test_repair.sh`: simulates corruption and validates full recovery.
- `test_uninstall.sh`: validates clean removal of services/files/processes.
- `smoke_test.sh`: validates runtime health and manifest parity.

Validation focus:
- deployment correctness,
- update integrity,
- service liveness,
- cleanup correctness,
- release readiness.
