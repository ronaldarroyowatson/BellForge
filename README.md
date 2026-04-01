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

## One-Line Installer

```bash
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash
```

## Fresh Raspberry Pi Quick Start

Use this single command on a brand-new Raspberry Pi OS install to install BellForge and start everything automatically:

```bash
curl -fsSL https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main/install.sh | sudo env BELLFORGE_REPO_OWNER=ronaldarroyowatson BELLFORGE_SERVER_IP=<YOUR_SERVER_IP> BELLFORGE_DISPLAY_ID=<PI_NAME_OR_ROOM> bash -s -- --install --yes
```

After install, BellForge will:
- reboot the Pi,
- auto-login,
- launch Chromium in kiosk mode,
- open the device status dashboard,
- show the URL for the settings page so users can connect from another device.

Common actions:

```bash
# Fresh install
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash -s -- --install

# Repair existing install
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash -s -- --repair

# Uninstall
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash -s -- --uninstall
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
- [Agent Context](docs/CONTEXT.md)
- [Deployment Guide](docs/deployment.md)
- [Debugging Guide](docs/debugging.md)

## Roadmap Summary

- Admin UI for fleet and schedule management.
- Classroom-specific logic and rule-based layouts.
- Countdown and event widgets.
- Multi-display orchestration for coordinated rollouts and content control.
