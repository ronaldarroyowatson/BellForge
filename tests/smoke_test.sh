#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

LOG_FILE="${TEST_LOG_DIR}/smoke.log"
exec > >(tee "${LOG_FILE}") 2>&1

require_root
print_info "Running BellForge smoke test"

curl -fsS "http://127.0.0.1:8000/health" >/dev/null
print_ok "Backend health endpoint reachable"

curl -fsS "http://127.0.0.1:8000/display/main" >/dev/null
print_ok "Client display endpoint reachable"

assert_service_active "bellforge-updater.service"

python3 - <<'PY'
import hashlib
import json
import urllib.request
from pathlib import Path

local_version = json.loads(Path('/opt/bellforge/config/version.json').read_text(encoding='utf-8')).get('version', '0.0.0')
settings = json.loads(Path('/opt/bellforge/config/settings.json').read_text(encoding='utf-8'))
base = settings['update_base_url'].rstrip('/')

remote_version = json.loads(urllib.request.urlopen(f"{base}/config/version.json", timeout=20).read().decode('utf-8')).get('version', '0.0.0')
if local_version != remote_version:
    raise SystemExit(f"Version mismatch local={local_version} remote={remote_version}")

remote_manifest = json.loads(urllib.request.urlopen(f"{base}/config/manifest.json", timeout=20).read().decode('utf-8'))
local_manifest = json.loads(Path('/opt/bellforge/config/manifest.json').read_text(encoding='utf-8'))
if remote_manifest.get('version') != local_manifest.get('version'):
    raise SystemExit('Manifest version mismatch')

for rel_path, meta in local_manifest.get('files', {}).items():
    target = Path('/opt/bellforge') / rel_path
    if not target.is_file():
        raise SystemExit(f"Missing file: {rel_path}")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != meta.get('sha256', ''):
        raise SystemExit(f"Hash mismatch: {rel_path}")

print('Smoke validation complete')
PY

print_ok "Smoke test completed successfully"
