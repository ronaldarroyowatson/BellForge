# BellForge Agent Context

This file is for AI agents and automation tools that need to understand BellForge quickly and make safe changes.

## 1. Purpose (What BellForge Is)

BellForge is a Raspberry Pi signage platform for schools.

Core behavior:
- Central backend exposes schedule and update metadata.
- Each Pi runs a kiosk client and an autonomous updater agent.
- Updates are manifest-driven, selective, and applied with staging/rollback safety.

## 2. Architecture Overview (How It Is Built)

Primary runtime components:
- `backend/`: FastAPI APIs + display payload endpoints.
- `client/`: browser signage UI (plain HTML/CSS/JS).
- `updater/`: async Python updater agent.
- `scripts/`: lifecycle automation and service units.
- `config/`: version, manifest, schedule, templates, payloads.
- `tests/`: install/repair/uninstall/smoke workflows.

Operational model:
- systemd manages backend/client/updater services.
- updater polls metadata, downloads changed files, stages and swaps managed roots.
- release tooling updates `version.json` and `manifest.json`.

## 3. Coding Conventions (How To Write Changes)

Python:
- Python 3.11+, full type hints, async FastAPI endpoints where applicable.
- small functions, explicit error handling, deterministic update logic.

JavaScript:
- modern ES without frameworks unless requested.
- resilient polling/rendering, clear schedule/time helpers.

Bash:
- `set -euo pipefail`, idempotent logic, explicit prerequisite checks.
- no hidden side effects; clear logs and non-interactive flags for CI.

Comment rule:
- explain intent/invariants, not obvious mechanics.

## 4. Update Workflow (Critical Path)

1. Updater loads settings (`BELLFORGE_SETTINGS` or default path).
2. Polls remote `config/version.json` and `config/manifest.json`.
3. Computes changed files via SHA-256 mismatch/missing-file checks.
4. Downloads only changed files to staging.
5. Builds shadow tree for managed roots (`backend`, `client`, `updater`, `config` when tracked).
6. Swaps roots atomically with rollback capability.
7. Writes local version/manifest tracking files.
8. Restarts configured services or reboots if required.

Do not break:
- hash verification,
- rollback path,
- preserve-local-path behavior (`config/settings.json`, `config/client.env`),
- version/manifest JSON schema compatibility.

## 5. Install / Repair / Uninstall Workflow

Install (`install.sh`):
- supports `--install`, `--repair`, `--reinstall`, `--uninstall`.
- provisions dependencies, syncs repo, creates venv, writes local config, installs services.

Repair (`scripts/repair.sh`):
- reconstructs missing structure,
- restores dependencies/services,
- optionally repairs from remote manifest.

Uninstall (`scripts/uninstall.sh`):
- stops/removes services,
- removes install footprint,
- optional purge and reboot behavior.

## 6. Test Suite Workflow

Main entrypoint:
- `tests/run_all_tests.sh`

Flow:
1. install test,
2. repair test (including corruption simulation),
3. uninstall test,
4. optional smoke test for runtime parity checks.

Release prep script (`scripts/prepare_release.sh`) also validates:
- test pass status,
- manifest integrity,
- update payload download completeness,
- version increment correctness.

## 7. Folder Structure (Agent Mental Model)

```text
backend/   -> server APIs and payload serving
client/    -> signage UI runtime
updater/   -> device update orchestration
scripts/   -> install/repair/uninstall/release and systemd units
config/    -> version/manifest/schedule/settings template/payload files
tests/     -> operational validation scripts
docs/      -> project documentation and process references
```

## 8. Key Scripts and Responsibilities

- `install.sh`: unified lifecycle entrypoint for device management.
- `scripts/bootstrap.sh`: fresh Pi bootstrap path.
- `scripts/repair.sh`: recover damaged install states.
- `scripts/uninstall.sh`: clean removal and optional purge.
- `scripts/generate_manifest.py`: build deployable file hash map.
- `scripts/bump_version.py`: semver increment + manifest regeneration.
- `scripts/prepare_release.sh`: release gatekeeper workflow.

## 9. Safe Modification Guidelines

Before changing update-critical code:
- trace how change impacts manifest generation and updater fetch paths,
- verify path allowlists and path traversal protections,
- run relevant tests (at minimum install/repair/update-related checks).

When editing config or updater logic:
- preserve backward compatibility for existing settings keys,
- avoid renaming tracked files without migration logic,
- avoid introducing non-atomic file replacement in live roots.

When editing service files/scripts:
- keep service names stable unless all references are updated,
- preserve restart/self-heal behavior,
- document any new environment variables in docs.

## 10. How To Avoid Breaking Autoupdate

Checklist:
1. Keep `config/version.json` valid semver JSON.
2. Keep `config/manifest.json` in sync with deployable files.
3. Never include device-local files (`config/settings.json`, `config/client.env`) in manifest.
4. Maintain SHA-256 verification before apply.
5. Preserve rollback semantics during root swaps.
6. Validate with `scripts/prepare_release.sh` (or equivalent manual checks).

If uncertain:
- choose additive, backward-compatible changes,
- document assumptions,
- avoid touching updater/install scripts and manifest schema in the same untested change set.
