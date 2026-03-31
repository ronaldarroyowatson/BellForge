#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

SUMMARY_FILE="${TEST_LOG_DIR}/summary.log"
: > "${SUMMARY_FILE}"

run_test() {
  local script_path="$1"
  print_info "Executing ${script_path}"
  if bash "${script_path}"; then
    print_ok "${script_path} passed"
    echo "PASS ${script_path}" >> "${SUMMARY_FILE}"
  else
    print_fail "${script_path} failed"
    echo "FAIL ${script_path}" >> "${SUMMARY_FILE}"
    exit 1
  fi
}

print_info "Running BellForge pre-deployment test sequence"
run_test "${SCRIPT_DIR}/test_install.sh"
run_test "${SCRIPT_DIR}/test_repair.sh"
run_test "${SCRIPT_DIR}/test_uninstall.sh"

print_ok "All tests passed"
print_info "Summary"
cat "${SUMMARY_FILE}"
