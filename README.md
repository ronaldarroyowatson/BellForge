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

Common actions:

```bash
# Fresh install
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash -s -- --install

# Repair existing install
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash -s -- --repair

# Uninstall
curl -sSL https://raw.githubusercontent.com/<YOUR_ORG_OR_USER>/BellForge/main/install.sh | bash -s -- --uninstall
```

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
