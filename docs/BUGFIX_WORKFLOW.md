# Bugfix Workflow

Use this workflow for production bugfix cycles and nightly closeout.

## 1. Branch and Scope

1. Branch from `main` using `bugfix/<short-name>` or `hotfix/<short-name>`.
2. Keep changes focused on one incident or bug class.
3. Avoid unrelated refactors in bugfix branches.

## 2. Verify the Fix

1. Run targeted tests for changed areas.
2. Run auth integrity suite (mandatory for any auth/device/account change):
   - `python tests/run_auth_suite.py --coverage`
   - `npm run test:auth`
2. Run smoke tests:
   - `python tests/smoke_test_windows.py` (dev/Windows)
   - `bash tests/smoke_test.sh` (Pi/system install)
3. Confirm service and API health on device:
   - `systemctl is-active bellforge-backend bellforge-client lightdm`
   - `curl http://127.0.0.1:8000/api/network/info`
   - `curl http://127.0.0.1:8000/api/display/pipeline`

## 3. Release Prep (Patch)

BellForge versioning is `X.Y.Z` (major.feature.bugfix). For bugfixes, increment only `Z`.

1. Bump patch and regenerate manifest:
   - `python scripts/bump_version.py patch`
2. Verify release artifacts changed as expected:
   - `config/version.json`
   - `config/manifest.json`
3. Commit with a bugfix-focused message:
   - `fix(display): stabilize kiosk startup and diagnostics`

Auth gate policy:
- Do not push bugfix version bumps unless auth suite passes locally.
- CI also enforces this in `.github/workflows/auth-tests.yml`, `.github/workflows/bugfix-smoke.yml`, and `.github/workflows/release.yml`.

Recommended local hook setup:
- `git config core.hooksPath .githooks`
- `chmod +x .githooks/pre-push`

## 4. Merge and Deploy

1. Open PR to `main`.
2. Ensure bugfix smoke workflow passes.
3. Merge to `main`.
4. Deploy updated files/services to target Pi(s).

## 5. Nightly Closeout

1. Capture final health snapshot in notes/logs.
2. Confirm active Pi IP and services are healthy.
3. Shut down cleanly for hardware safety:
   - `ssh <pi-host> "sudo shutdown -h now"`
