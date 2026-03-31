#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

LOG_FILE="${TEST_LOG_DIR}/uninstall.log"
exec > >(tee "${LOG_FILE}") 2>&1

trap 'stop_local_repo_server' EXIT

require_root
print_info "Running BellForge uninstall test"

start_local_repo_server 18080
run_install_action --install
bash "${REPO_ROOT}/scripts/uninstall.sh" --yes --no-reboot --purge

assert_not_exists "/opt/bellforge" "Install directory removed"
assert_service_missing "bellforge-backend.service"
assert_service_missing "bellforge-client.service"
assert_service_missing "bellforge-updater.service"

if compgen -G "/var/log/bellforge-*" > /dev/null; then
  print_fail "BellForge logs still exist"
  exit 1
else
  print_ok "BellForge logs removed"
fi

if pgrep -f "bellforge|updater/agent.py|backend.main:app" >/dev/null 2>&1; then
  print_fail "BellForge processes still running"
  pgrep -fa "bellforge|updater/agent.py|backend.main:app" || true
  exit 1
else
  print_ok "No BellForge processes running"
fi

print_ok "Uninstall test completed successfully"
