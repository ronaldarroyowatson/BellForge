#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_LOG_DIR="${REPO_ROOT}/tests/logs"
INSTALL_DIR="/opt/bellforge"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "${TEST_LOG_DIR}"

print_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
print_ok() { echo -e "${GREEN}[PASS]${NC} $*"; }
print_fail() { echo -e "${RED}[FAIL]${NC} $*"; }

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    print_fail "Tests must run as root (or via sudo)."
    exit 1
  fi
}

assert_exists() {
  local path="$1"
  local message="$2"
  if [[ -e "${path}" ]]; then
    print_ok "${message}"
  else
    print_fail "${message}"
    return 1
  fi
}

assert_not_exists() {
  local path="$1"
  local message="$2"
  if [[ ! -e "${path}" ]]; then
    print_ok "${message}"
  else
    print_fail "${message}"
    return 1
  fi
}

assert_service_active() {
  local service="$1"
  if systemctl is-active --quiet "${service}"; then
    print_ok "Service active: ${service}"
  else
    print_fail "Service inactive: ${service}"
    return 1
  fi
}

assert_service_missing() {
  local service="$1"
  if systemctl list-unit-files | grep -q "^${service}"; then
    print_fail "Service still installed: ${service}"
    return 1
  else
    print_ok "Service removed: ${service}"
  fi
}

start_local_repo_server() {
  local port="${1:-18080}"
  print_info "Starting local repo server on port ${port}"
  pushd "${REPO_ROOT}" >/dev/null
  python3 -m http.server "${port}" >/tmp/bellforge-test-http.log 2>&1 &
  REPO_SERVER_PID="$!"
  popd >/dev/null
  sleep 1
  export BELLFORGE_TEST_REPO_SERVER_PID="${REPO_SERVER_PID}"
}

stop_local_repo_server() {
  if [[ -n "${BELLFORGE_TEST_REPO_SERVER_PID:-}" ]] && kill -0 "${BELLFORGE_TEST_REPO_SERVER_PID}" 2>/dev/null; then
    print_info "Stopping local repo server PID ${BELLFORGE_TEST_REPO_SERVER_PID}"
    kill "${BELLFORGE_TEST_REPO_SERVER_PID}" || true
  fi
}

get_repo_source() {
  local branch
  branch="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  echo "${REPO_ROOT}|${branch}"
}

run_install_action() {
  local action="$1"
  local repo_info branch
  repo_info="$(get_repo_source)"
  branch="${repo_info#*|}"

  BELLFORGE_REPO_URL="${repo_info%%|*}" \
  BELLFORGE_BRANCH="${branch}" \
  BELLFORGE_REPO_OWNER="local" \
  BELLFORGE_UPDATE_BASE_URL="http://127.0.0.1:18080" \
  BELLFORGE_SERVER_IP="127.0.0.1" \
  BELLFORGE_DISPLAY_ID="main" \
  bash "${REPO_ROOT}/install.sh" "${action}" --yes --no-reboot
}
