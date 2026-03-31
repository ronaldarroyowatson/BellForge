# Contributing to BellForge

## 1. Development Environment Setup

Prerequisites:
- Python 3.11+
- Git
- Bash shell (Linux/macOS, or WSL/Git Bash on Windows)

Setup:

```bash
git clone https://github.com/<YOUR_ORG_OR_USER>/BellForge.git
cd BellForge
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pip install -r updater/requirements.txt
```

Generate/update manifest after code changes that affect deployable files:

```bash
python scripts/generate_manifest.py
```

## 2. Run the Backend Locally

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Quick checks:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/api/version
curl http://127.0.0.1:8000/api/schedule
```

Note:
- Some environments may still expose compatibility endpoints like `/version` and `/manifest`.

## 3. Run the Client Locally

Option A (simple static hosting):

```bash
cd client
python -m http.server 8080
```

Open `http://127.0.0.1:8080` in your browser.

Option B (Pi-like behavior):
- Run backend on port 8000.
- Use Chromium with kiosk flags against display endpoint:

```bash
chromium-browser --kiosk --app=http://127.0.0.1:8000/display/main
```

## 4. Simulate a Pi Environment

Local simulation pattern:

```bash
mkdir -p /tmp/bellforge-test/config
cat > /tmp/bellforge-test/config/version.json <<'EOF'
{"version":"0.0.0"}
EOF

cat > /tmp/bellforge-test/settings.json <<'EOF'
{
  "update_base_url": "http://127.0.0.1:8000",
  "install_dir": "/tmp/bellforge-test",
  "staging_dir": "/tmp/bellforge-test/.staging",
  "log_file": "/tmp/bellforge-test/updater.log",
  "poll_interval_seconds": 30,
  "max_retries": 2,
  "retry_delay_seconds": 5,
  "services_to_restart": [],
  "preserve_local_paths": ["config/settings.json", "config/client.env"]
}
EOF
```

Then run updater with explicit settings:

```bash
BELLFORGE_SETTINGS=/tmp/bellforge-test/settings.json python updater/agent.py
```

## 5. Run Updater in Debug Mode

Debug suggestions:
- Set short poll intervals in test settings.
- Point `update_base_url` to a local server serving repo files.
- Tail logs while running agent.

```bash
python -m http.server 18080
BELLFORGE_SETTINGS=/tmp/bellforge-test/settings.json python updater/agent.py
tail -f /tmp/bellforge-test/updater.log
```

## 6. Run the Test Suite

Main suite:

```bash
bash tests/run_all_tests.sh
```

Individual tests:

```bash
bash tests/test_install.sh
bash tests/test_repair.sh
bash tests/test_uninstall.sh
bash tests/smoke_test.sh
```

Notes:
- Some tests require root/systemd-capable environments.
- Logs are written under `tests/logs`.

## 7. Prepare a Release

Recommended scripted workflow:

```bash
bash scripts/prepare_release.sh
```

This workflow performs:
1. Run tests.
2. Regenerate manifest.
3. Bump version.
4. Validate manifest and update payload integrity.
5. Create release commit and tag.

Manual equivalent:
1. Run test suite.
2. Regenerate manifest (`python scripts/generate_manifest.py`).
3. Bump version (`python scripts/bump_version.py patch`).
4. Validate repository integrity (manifest references + hashes).
5. Commit `config/version.json` and `config/manifest.json`.
6. Tag release (`git tag vX.Y.Z`).
7. Push branch and tag to GitHub.

Versioning policy:
- BellForge follows `major.feature.bugfix` (`X.Y.Z`).
- Default to patch (`Z`) increments for bugfix/release updates.

## 8. Branching Strategy

- `main` is always releasable.
- Use short-lived feature/fix branches from `main`.
- Open PRs early for visibility on architecture-impacting changes.
- Rebase or merge from `main` frequently for low drift.

Suggested branch names:
- `feature/<scope>`
- `fix/<scope>`
- `chore/<scope>`

## 9. Commit Message Guidelines

Use clear, imperative summaries with scope where helpful.

Examples:
- `feat(client): add passing-period visual state`
- `fix(updater): rollback on managed-root swap failure`
- `docs: refresh architecture update flow diagram`
- `chore: release v0.1.1`

Guidelines:
- Keep subject concise and action-oriented.
- Mention why in body for non-trivial changes.
- Reference issue IDs when available.
