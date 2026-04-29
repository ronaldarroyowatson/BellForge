# Bugfix Workflow

Use this workflow for production bugfix cycles and nightly closeout.

## 1. Branch and Scope

1. Do bugfix work directly on `main` unless explicitly instructed otherwise.
2. Keep changes focused on one incident or bug class.
3. Avoid unrelated refactors in bugfix commits.

## 2. Verify the Fix

1. Run targeted tests for changed areas.
    - For branch synchronization or checkout tooling changes, run:
       - `npm run test:branch-toggle`
2. Run browser-driven layout verification for any layout, card, token, collapse/expand, drag-and-drop, or real display verification change:
   - `npm run test:layout`
   - This starts or reuses the real backend on `http://127.0.0.1:8000`, opens the real Status page, Settings page, and display output in a headless browser, exercises collapse/expand, resize, drag-and-drop, and shared layout commands, then writes DOM geometry and console artifacts under `tests/logs/layout-browser/`.
   - The layout gate must cover the preview/live sync batch explicitly: preview bootstrap without auth, unsaved preview edits staying local until Save Layout is clicked, delayed shared-layout refreshes not overwriting pending local edits, and the saved preview layout propagating to the live display surface.
   - The browser verifier resets saved layout state and re-runs once after an automatic layout-state repair. If it still fails, do not accept the fix.
2. Run auth integrity suite (mandatory for any auth/device/account change):
   - `python tests/run_auth_suite.py --coverage`
   - `npm run test:auth`
   - `node --test tests/test_auth_onboarding_workflow.js`
   - `node scripts/run_python.js -m unittest tests.test_unified_auth_integration`
   - `node scripts/run_python.js -m unittest tests.test_control_permissions_auth_lock`
   - `node scripts/run_python.js -m unittest tests.test_dev_admin_local_auth`
3. Run control-server architecture tests (mandatory for any server/satellite role, discovery, onboarding authority, or layout permission change):
   - `python -m pytest tests/test_control_server.py -q`
   - If the legacy control suite is being migrated, run contract-focused coverage in parallel:
     - `node scripts/run_python.js -m unittest tests.test_control_permissions_auth_lock`
2. Run smoke tests:
   - `node scripts/run_python.js tests/smoke_test_windows.py` (dev/Windows)
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
- Do not push layout/card/token/preview fixes unless `npm run test:layout` passes locally.
- CI also enforces this in `.github/workflows/auth-tests.yml`, `.github/workflows/bugfix-smoke.yml`, and `.github/workflows/release.yml`.

Recommended local hook setup:
- `git config core.hooksPath .githooks`
- `chmod +x .githooks/pre-push`

## 4. Merge and Deploy

1. Commit directly on `main` with a bugfix-focused message.
2. Push directly to `origin/main`.
3. Confirm remote sync:
   - `git log --oneline origin/main | head -1`
4. Verify the real Pi rollout before closing the bugfix:
    - Run `npm run verify:pi-rollout -- --pi-host 192.168.2.180 --expected-version X.Y.Z`
    - The verifier must prove all of these before the bugfix is considered closed:
       - the real Status page is audited before rollout and while staged, then passes with no browser-visible errors or regressions after apply
       - the Pi detects the new published version (`latest_detected_version`)
       - the update is fully downloaded and staged (`staged_update_pending=true`, `staged_release_version=X.Y.Z`, download progress at 100%)
       - the Pi is rebooted and returns to service
       - the staged update is actually applied (`current_device_version=X.Y.Z`, `staged_update_pending=false`)
       - the real browser surfaces on the Pi still behave correctly after apply:
          - `/status`
          - `/settings`
          - `/status?view=display`
    - The verifier writes JSON and screenshot evidence under `tests/logs/pi-rollout/`.
    - Do not close the bugfix if the Pi is already on the expected version unless you intentionally rerun with `--allow-already-current` for audit-only evidence; first-closeout validation must capture stage plus apply.
5. Run live Pi lifecycle tests after rollout apply/reboot is confirmed:
   - `BELLFORGE_PI_HOST=192.168.2.180 BELLFORGE_PI_SSH_KEY_PATH=<path-to-private-key> bash tests/live_pi_lifecycle.sh`
   - This must pass after the Pi has applied `X.Y.Z` and returned from reboot.
6. Run live Pi auth-path lifecycle validation after rollout apply/reboot is confirmed:
   - `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pi_auth_e2e_check.ps1 -BaseUrl http://192.168.2.180:8000 -Email <test-email> -Password <test-password> -Name <display-name>`
   - This flow must prove local register/login, token verification, layout-edit permission checks, server promotion, returning login, local-auth delete, and post-delete login failure.
   - For first-closeout auth incidents, run the command with the incident account first (for example `rarroyo-watson@tulsaacademy.org`) before running a throwaway test account.
   - If incident-account login fails with `local_user_exists` plus `invalid_credentials`, do not close silently: record the account-recovery blocker and attach the successful throwaway-account run evidence.
7. Automatic post-push enforcement on `main`:
    - `.github/workflows/release.yml` now runs the full layout DOM suite, debug unit tests, auth suite, release publication, and then the live Pi rollout verifier automatically after each push to `main`.
    - The post-push verifier must confirm, in order:
       - published version detected on the Pi
       - update fully downloaded
       - update staged
       - Pi rebooted
       - expected version applied
       - `/status`, `/settings`, and `/status?view=display` all pass live browser checks on the Pi
    - The workflow uploads `tests/logs/pi-rollout/` and `tests/logs/bellforge-debug/` as artifacts.

## 5. Nightly Closeout

1. Capture final health snapshot in notes/logs.
2. Confirm active Pi IP and services are healthy.
3. Shut down cleanly for hardware safety:
   - `ssh <pi-host> "sudo shutdown -h now"`
