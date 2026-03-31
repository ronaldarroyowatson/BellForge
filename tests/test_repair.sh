#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

LOG_FILE="${TEST_LOG_DIR}/repair.log"
exec > >(tee "${LOG_FILE}") 2>&1

trap 'stop_local_repo_server' EXIT

require_root
print_info "Running BellForge repair test"

start_local_repo_server 18080
run_install_action --install

print_warn "Simulating corruption and partial install damage"
python3 - <<'PY'
import json
import random
from pathlib import Path

manifest = json.loads(Path('/opt/bellforge/config/manifest.json').read_text(encoding='utf-8'))
files = [p for p in manifest.get('files', {}).keys() if p.startswith(('backend/', 'client/', 'updater/'))]
random.shuffle(files)
for rel in files[:3]:
    p = Path('/opt/bellforge') / rel
    if p.exists():
        p.unlink()

(Path('/opt/bellforge/config/manifest.json')).write_text('{"corrupt": true', encoding='utf-8')
PY

rm -f /etc/systemd/system/bellforge-client.service
rm -f /etc/systemd/system/bellforge-updater.service
systemctl daemon-reload
rm -f /opt/bellforge/.venv/bin/pip

bash "${REPO_ROOT}/scripts/repair.sh" --yes

assert_exists "/opt/bellforge/.venv/bin/python" "Python venv restored"
assert_exists "/opt/bellforge/config/version.json" "version.json restored"
assert_exists "/opt/bellforge/config/manifest.json" "manifest.json restored"
assert_exists "/etc/systemd/system/bellforge-client.service" "Client service recreated"
assert_exists "/etc/systemd/system/bellforge-updater.service" "Updater service recreated"

assert_service_active "bellforge-backend.service"
assert_service_active "bellforge-client.service"
assert_service_active "bellforge-updater.service"

python3 - <<'PY'
import json
import hashlib
from pathlib import Path

version = json.loads(Path('/opt/bellforge/config/version.json').read_text(encoding='utf-8'))
manifest = json.loads(Path('/opt/bellforge/config/manifest.json').read_text(encoding='utf-8'))

if 'version' not in version:
    raise SystemExit('version.json missing version key')
if 'files' not in manifest or not isinstance(manifest['files'], dict):
    raise SystemExit('manifest.json missing files map')

for rel_path, meta in manifest['files'].items():
  target = Path('/opt/bellforge') / rel_path
  if not target.is_file():
    raise SystemExit(f'missing restored file: {rel_path}')
  digest = hashlib.sha256(target.read_bytes()).hexdigest()
  if digest != meta.get('sha256', ''):
    raise SystemExit(f'hash mismatch after repair: {rel_path}')

print('Version and manifest JSON are valid')
PY

if pgrep -f "updater/agent.py" >/dev/null 2>&1; then
  print_ok "Updater process is running after repair"
else
  print_fail "Updater process is not running after repair"
  exit 1
fi

print_ok "Repair test completed successfully"
