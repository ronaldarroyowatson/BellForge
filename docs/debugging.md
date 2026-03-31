# Debugging Guide

## Checking service status on a Pi

```bash
# View all BellForge service statuses at once
systemctl status bellforge-updater bellforge-file-server bellforge-client

# Follow the updater log in real time
journalctl -u bellforge-updater -f

# View the rotating log file
tail -f /var/log/bellforge/updater.log

# View recent entries
journalctl -u bellforge-updater --since "1 hour ago"
```

---

## Manually triggering an update

```bash
# From the Pi itself
curl -X POST http://localhost:8765/trigger-update

# Check what version the Pi thinks it has
curl http://localhost:8765/health
```

---

## Inspecting the local state

```bash
# What version is installed?
cat /opt/bellforge/config/version.json

# What does the server say the version is?
curl http://YOUR_SERVER:8000/api/version

# Does the local manifest match the server's?
curl http://YOUR_SERVER:8000/api/manifest | python3 -m json.tool

# Check individual file hashes
python3 -c "
import hashlib, json, pathlib
manifest = json.loads(pathlib.Path('/opt/bellforge/config/manifest.json' if pathlib.Path('/opt/bellforge/config/manifest.json').exists() else 'config/manifest.json').read_text())
for path, meta in manifest['files'].items():
    p = pathlib.Path('/opt/bellforge') / path
    if p.is_file():
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        status = 'OK' if h == meta['sha256'] else 'MISMATCH'
        print(f'{status:8}  {path}')
    else:
        print(f'MISSING   {path}')
"
```

---

## Debugging the backend locally

```bash
# Start with auto-reload
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000

# Test each endpoint
curl http://localhost:8000/health
curl http://localhost:8000/api/version
curl http://localhost:8000/api/manifest
curl http://localhost:8000/api/schedule
curl http://localhost:8000/api/files/client/index.html

# Interactive API docs
open http://localhost:8000/docs
```

---

## Simulating a Pi update locally (without a real Pi)

```bash
# 1. Start the backend
uvicorn backend.main:app --port 8000 &

# 2. Create a fake install dir
mkdir -p /tmp/bellforge-test/config
echo '{"version":"0.0.0"}' > /tmp/bellforge-test/config/version.json

# 3. Write a test settings.json
cat > /tmp/test-settings.json <<'EOF'
{
  "server_url": "http://localhost:8000",
  "poll_interval_seconds": 10,
  "install_dir": "/tmp/bellforge-test",
  "staging_dir": "/tmp/bellforge-staging",
  "log_dir": "/tmp/bellforge-logs",
  "trigger_port": 8765,
  "max_retries": 2,
  "retry_delay_seconds": 5,
  "reboot_command": "echo REBOOT_WOULD_HAPPEN",
  "services_to_restart": [],
  "device_id": "local-test"
}
EOF

# 4. Run the updater agent
BELLFORGE_SETTINGS=/tmp/test-settings.json python updater/agent.py
```

The agent will download all files from the backend into `/tmp/bellforge-test`.

---

## Common issues

### "settings.json not found"

The updater cannot find its config. Set `BELLFORGE_SETTINGS` env var or ensure the file is at `/opt/bellforge/config/settings.json`.

### "version.json not found" on the server

Run `python scripts/generate_manifest.py` first, then ensure `config/version.json` exists.

### Pi stuck on a version after an update to the manifest

Check that the manifest was committed:
```bash
git log --oneline config/manifest.json
```

If the manifest is stale, manually run `python scripts/generate_manifest.py` and commit/push.

### Hash mismatch during update

The backend is serving a file that doesn't match the manifest. This usually means the manifest was regenerated but the file wasn't committed, or vice versa. Re-run `generate_manifest.py`, commit, and push.

### Chromium not starting

Check the X display is available:
```bash
DISPLAY=:0 chromium-browser --version
```

Check the file server is running:
```bash
curl http://localhost:8080/
```

### Service won't start after update

The updater restarts only the services listed in `services_to_restart`. Ensure `bellforge-client.service` and `bellforge-file-server.service` are in that list. For the updater itself to reload new code, a reboot is required (set `"reboot_required": true` in `version.json` or manually `sudo systemctl restart bellforge-updater`).

---

## Suggested logging breakpoints in agent.py

| Location | What to watch |
|----------|--------------|
| `_needs_update` | Confirm version comparison is correct |
| `_find_changed_files` | Confirm hashes are being computed correctly |
| `_stage` | Watch download progress for large updates |
| `_verify_staged` | Catch hash mismatches before applying |
| `_apply_staged` | Confirm files land in the right location |
| `poll_loop` | Confirm the trigger event fires correctly |
