# BellForge

BellForge is a Raspberry Pi-based, schedule-aware digital signage platform for schools. It combines a FastAPI backend, kiosk-mode display client, and resilient updater workflow so IT teams can manage displays with minimal manual intervention.

## Project Overview

BellForge is designed for real school operations:
- predictable classroom and hallway displays,
- centralized schedule and update delivery,
- install/repair/uninstall lifecycle tooling,
- robust manifest-based autoupdates with atomic apply behavior.

## Key Features

- Raspberry Pi signage client in Chromium kiosk mode.
- FastAPI backend for schedule, version, manifest, and content delivery.
- Manifest-driven autoupdate pipeline with selective file downloads.
- Atomic update staging with rollback-aware managed root swaps.
- Unified install, repair, and uninstall workflows.
- Release readiness checks and operational test suite.

## Teacher Quick Start (One Command)

If you are a teacher and not technical, this is the command to copy and paste on a Raspberry Pi terminal.

```bash
curl -fsSL https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main/install.sh | sudo env BELLFORGE_REPO_OWNER=ronaldarroyowatson BELLFORGE_SERVER_IP=127.0.0.1 BELLFORGE_DISPLAY_ID=Classroom-Display bash -s -- --install --yes
```

What this does for you automatically:
- installs everything BellForge needs (including git and Python tools),
- sets up startup services,
- reboots the Pi,
- opens BellForge in kiosk mode,
- shows the status page and settings URL.

For older TVs and slow HDMI handshakes:
- BellForge now sends HDMI-CEC power-on commands before launching kiosk mode.
- BellForge waits for HDMI connection before opening Chromium (default: 45 seconds).
- BellForge waits for X display readiness before launching Chromium (default: 45 seconds).
- You can tune this in `/opt/bellforge/config/client.env`:
  - `BELLFORGE_CEC_POWER_ON=1`
  - `BELLFORGE_HDMI_WAIT_SECONDS=45`
  - `BELLFORGE_X_WAIT_SECONDS=45`

What you need to do:
1. Open Terminal on the Pi.
2. Paste the command above.
3. Press Enter and wait for it to finish.

Optional: If this Pi should use a central BellForge server instead of itself, replace `BELLFORGE_SERVER_IP=127.0.0.1` with your server IP.

## One-Line Commands (Install/Repair/Uninstall)

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main/install.sh | sudo env BELLFORGE_REPO_OWNER=ronaldarroyowatson BELLFORGE_SERVER_IP=127.0.0.1 BELLFORGE_DISPLAY_ID=Classroom-Display bash -s -- --install --yes

# Repair
curl -fsSL https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main/install.sh | sudo env BELLFORGE_REPO_OWNER=ronaldarroyowatson BELLFORGE_SERVER_IP=127.0.0.1 BELLFORGE_DISPLAY_ID=Classroom-Display bash -s -- --repair --yes

# Uninstall
curl -fsSL https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main/install.sh | sudo env BELLFORGE_REPO_OWNER=ronaldarroyowatson BELLFORGE_SERVER_IP=127.0.0.1 BELLFORGE_DISPLAY_ID=Classroom-Display bash -s -- --uninstall --yes
```

## Bugfix Workflow

Use this lightweight workflow for production bugfixes:

1. Create a bugfix branch from `main` (`bugfix/<short-name>` or `hotfix/<short-name>`).
2. Implement the fix and keep changes scoped to the issue.
3. Run smoke tests locally.
4. Open a pull request to `main`.
5. Confirm the `Bugfix Smoke Test` GitHub Action passes.
6. Merge to `main`.

Patch releases are handled by the release workflow after merge.

## Smoke Tests

Raspberry Pi smoke test (installed device):

```bash
sudo bash tests/smoke_test.sh
```

Windows/dev smoke test:

```bash
python tests/smoke_test_windows.py
```

CI bugfix smoke test:
- Runs automatically for pull requests to `main`.
- Runs on pushes to `bugfix/**` and `hotfix/**` branches.
- Workflow file: `.github/workflows/bugfix-smoke.yml`

Live Pi lifecycle smoke test (same workflow):
- Runs after backend smoke on every bugfix/hotfix cycle.
- Executes a real lifecycle on a Raspberry Pi: uninstall -> install -> repair (with injected damage) -> uninstall.
- Uses one-line installer commands from GitHub raw content.
- Uploads local and remote lifecycle logs as CI artifacts.
- Requires a Linux self-hosted runner with SSH access to the Pi.
- Requires these runner environment variables:
  - `BELLFORGE_PI_HOST` (required)
  - `BELLFORGE_PI_USER` (optional, defaults to `pi`)
  - `BELLFORGE_PI_SSH_KEY` (required, private key content)

## Screenshots

Screenshot placeholders:
- `docs/screenshots/dashboard-overview.png`
- `docs/screenshots/classroom-display.png`
- `docs/screenshots/kiosk-period-transition.png`

## Basic Usage

Start backend locally:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pip install -r updater/requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Run full test suite:

```bash
bash tests/run_all_tests.sh
```

Prepare a release:

```bash
bash scripts/prepare_release.sh
```

## Architecture Snapshot

```text
Developer changes -> version + manifest update -> release commit/tag
  |
  v
Backend serves schedule/content/update metadata
  |
  v
Pi updater polls -> downloads changed files -> stages -> atomic apply
  |
  v
Services restart (or reboot) -> display continues with new version
```

## Documentation

- [PRD](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Coding Conventions](docs/CODING_CONVENTIONS.md)
- [Contributing Guide](docs/CONTRIBUTING.md)
- [Bugfix Workflow](docs/BUGFIX_WORKFLOW.md)
- [Agent Context](docs/CONTEXT.md)
- [Deployment Guide](docs/deployment.md)
- [Debugging Guide](docs/debugging.md)

## Roadmap Summary

- Admin UI for fleet and schedule management.
- Classroom-specific logic and rule-based layouts.
- Countdown and event widgets.
- Multi-display orchestration for coordinated rollouts and content control.
