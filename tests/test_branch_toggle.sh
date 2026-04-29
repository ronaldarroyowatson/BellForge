#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

LOG_FILE="${TEST_LOG_DIR}/branch_toggle.log"
exec > >(tee "${LOG_FILE}") 2>&1

BRANCH_TOGGLE_SCRIPT="${REPO_ROOT}/branch-toggle.sh"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    print_ok "${message}"
  else
    print_fail "${message} (expected='${expected}' actual='${actual}')"
    return 1
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    print_ok "${message}"
  else
    print_fail "${message} (missing '${needle}')"
    return 1
  fi
}

require_tool() {
  local tool="$1"
  if ! command -v "${tool}" >/dev/null 2>&1; then
    print_fail "Missing required tool: ${tool}"
    exit 1
  fi
}

run_in_repo() {
  local repo="$1"
  shift
  (
    cd "${repo}"
    "$@"
  )
}

print_info "Running branch-toggle regression test"
require_tool git
require_tool bash

if [[ ! -f "${BRANCH_TOGGLE_SCRIPT}" ]]; then
  print_fail "Missing branch toggle script at ${BRANCH_TOGGLE_SCRIPT}"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ORIGIN_REPO="${TMP_DIR}/origin.git"
SEED_REPO="${TMP_DIR}/seed"
WORK_REPO="${TMP_DIR}/work"

git init --bare "${ORIGIN_REPO}" >/dev/null

git init "${SEED_REPO}" >/dev/null
run_in_repo "${SEED_REPO}" git config user.name "BellForge Test"
run_in_repo "${SEED_REPO}" git config user.email "tests@bellforge.local"
run_in_repo "${SEED_REPO}" git remote add origin "${ORIGIN_REPO}"

echo "main-v1" > "${SEED_REPO}/state.txt"
run_in_repo "${SEED_REPO}" git add state.txt
run_in_repo "${SEED_REPO}" git commit -m "seed main" >/dev/null
run_in_repo "${SEED_REPO}" git branch -M main
run_in_repo "${SEED_REPO}" git push -u origin main >/dev/null

run_in_repo "${SEED_REPO}" git checkout -b auth-fix-cloud >/dev/null
echo "cloud-v1" > "${SEED_REPO}/state.txt"
run_in_repo "${SEED_REPO}" git add state.txt
run_in_repo "${SEED_REPO}" git commit -m "seed cloud" >/dev/null
run_in_repo "${SEED_REPO}" git push -u origin auth-fix-cloud >/dev/null

git clone "${ORIGIN_REPO}" "${WORK_REPO}" >/dev/null 2>&1
cp "${BRANCH_TOGGLE_SCRIPT}" "${WORK_REPO}/branch-toggle.sh"
chmod +x "${WORK_REPO}/branch-toggle.sh"
run_in_repo "${WORK_REPO}" git config user.name "BellForge Test"
run_in_repo "${WORK_REPO}" git config user.email "tests@bellforge.local"

run_in_repo "${WORK_REPO}" git checkout main >/dev/null

print_info "Verifying cloud switch"
run_in_repo "${WORK_REPO}" bash ./branch-toggle.sh cloud
ACTIVE_BRANCH="$(run_in_repo "${WORK_REPO}" git rev-parse --abbrev-ref HEAD)"
assert_eq "auth-fix-cloud" "${ACTIVE_BRANCH}" "Switched to auth-fix-cloud"
STATE_CONTENT="$(cat "${WORK_REPO}/state.txt")"
assert_eq "cloud-v1" "${STATE_CONTENT}" "Cloud branch content present"

print_info "Verifying main switch"
run_in_repo "${WORK_REPO}" bash ./branch-toggle.sh main
ACTIVE_BRANCH="$(run_in_repo "${WORK_REPO}" git rev-parse --abbrev-ref HEAD)"
assert_eq "main" "${ACTIVE_BRANCH}" "Switched back to main"
STATE_CONTENT="$(cat "${WORK_REPO}/state.txt")"
assert_eq "main-v1" "${STATE_CONTENT}" "Main branch content present"

print_info "Verifying invalid argument handling"
set +e
INVALID_OUTPUT="$(run_in_repo "${WORK_REPO}" bash ./branch-toggle.sh bogus 2>&1)"
INVALID_EXIT=$?
set -e
if [[ ${INVALID_EXIT} -eq 0 ]]; then
  print_fail "Invalid argument unexpectedly succeeded"
  exit 1
fi
assert_contains "${INVALID_OUTPUT}" "Usage:" "Invalid argument prints usage"

print_info "Verifying dirty tracked-change guard"
echo "dirty-change" > "${WORK_REPO}/state.txt"
set +e
DIRTY_OUTPUT="$(run_in_repo "${WORK_REPO}" bash ./branch-toggle.sh cloud 2>&1)"
DIRTY_EXIT=$?
set -e
if [[ ${DIRTY_EXIT} -eq 0 ]]; then
  print_fail "Dirty tracked change guard unexpectedly succeeded"
  exit 1
fi
assert_contains "${DIRTY_OUTPUT}" "Uncommitted tracked changes detected" "Dirty tracked change is blocked"
run_in_repo "${WORK_REPO}" git checkout -- state.txt

print_info "Verifying git lock guard"
touch "${WORK_REPO}/.git/index.lock"
set +e
LOCK_OUTPUT="$(run_in_repo "${WORK_REPO}" bash ./branch-toggle.sh cloud 2>&1)"
LOCK_EXIT=$?
set -e
rm -f "${WORK_REPO}/.git/index.lock"
if [[ ${LOCK_EXIT} -eq 0 ]]; then
  print_fail "Index lock guard unexpectedly succeeded"
  exit 1
fi
assert_contains "${LOCK_OUTPUT}" "Git lock file detected" "Index lock is detected"

print_ok "Branch toggle regression test completed successfully"
