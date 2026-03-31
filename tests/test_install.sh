#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

LOG_FILE="${TEST_LOG_DIR}/install.log"
exec > >(tee "${LOG_FILE}") 2>&1

trap 'stop_local_repo_server' EXIT

require_root
print_info "Running BellForge install test"

start_local_repo_server 18080
run_install_action --install

assert_exists "/opt/bellforge" "Install directory exists"
assert_exists "/opt/bellforge/.venv/bin/python" "Python venv exists"
assert_exists "/opt/bellforge/config/version.json" "version.json exists"
assert_exists "/opt/bellforge/config/manifest.json" "manifest.json exists"

assert_service_active "bellforge-backend.service"
assert_service_active "bellforge-client.service"
assert_service_active "bellforge-updater.service"

if pgrep -f "updater/agent.py" >/dev/null 2>&1; then
  print_ok "Updater process is running"
else
  print_fail "Updater process is not running"
  exit 1
fi

print_ok "Install test completed successfully"
