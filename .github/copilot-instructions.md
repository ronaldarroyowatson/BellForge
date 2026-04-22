# GitHub Copilot Instructions for BellForge

## Branch Policy

**All bugfixes and feature work must be committed directly to `main` and pushed to `origin/main`.**

- Do not create feature branches or bugfix branches unless explicitly instructed by the user.
- `git push` always targets `main` unless the user explicitly says otherwise.
- After any commit, confirm `main` is fully in sync with `origin/main` before closing out a task.
- The Pi device updater polls `origin/main` for version changes — work that never lands on `main` will never be picked up by the Pi.

## Versioning

- Version scheme: `major.feature.bugfix` (X.Y.Z)
- Only bump Z (bugfix counter) unless the user explicitly requests a Y (feature) or X (major) bump.
- Do not roll Y when Z reaches 10 — keep incrementing Z.
- Always update `config/version.json` with an ISO-8601 `released_at` timestamp when bumping the version.

## Bugfix Workflow

1. Make all code changes.
2. Bump `config/version.json` (Z increment).
3. Run the full local test suite and confirm all gates pass:
   - `npm run test:layout` (unit tests)
   - `npm run test:layout:browser` (browser suites)
   - Auth suite and debug service tests where relevant
4. Commit all changes on `main`: `git add -A && git commit -m "fix(...): ..."`
5. `git push origin main`
6. Confirm `origin/main` is at the new commit: `git log --oneline origin/main | head -1`
7. Monitor Pi update cycle: `npm run verify:pi-rollout -- --pi-host 192.168.2.180 --expected-version X.Y.Z ...`

## Pi Device

- Pi IP: `192.168.2.180`, backend port `8000`
- Updater polls `https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main` every 5 minutes
- Version detection endpoint: `http://192.168.2.180:8000/api/version`
- Rollout verifier: `npm run verify:pi-rollout -- --pi-host 192.168.2.180 --expected-version <version> --stage-timeout-ms 120000 --apply-timeout-ms 120000 --reboot-down-timeout-ms 60000 --reboot-up-timeout-ms 120000`

## General

- Do not add features, refactor, or make "improvements" beyond what is directly requested.
- Keep commits focused and atomic.
- Follow the BUGFIX_WORKFLOW.md doc for detailed step-by-step guidance.
