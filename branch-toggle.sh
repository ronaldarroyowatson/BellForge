#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <cloud|main>"
  echo "  cloud -> auth-fix-cloud"
  echo "  main  -> main"
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

TARGET="${1}"
case "${TARGET}" in
  cloud)
    BRANCH="auth-fix-cloud"
    ;;
  main)
    BRANCH="main"
    ;;
  *)
    usage
    exit 1
    ;;
esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[ERROR] This script must be run inside a git repository."
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

if [[ -f "${REPO_ROOT}/.git/index.lock" ]]; then
  echo "[ERROR] Git lock file detected at .git/index.lock"
  echo "[ERROR] Ensure no git process is running, then remove the lock file and retry."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${CURRENT_BRANCH}" != "${BRANCH}" ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "[ERROR] Uncommitted tracked changes detected. Commit or stash before switching branches."
    exit 1
  fi
fi

echo "[INFO] Repo root: ${REPO_ROOT}"
echo "[INFO] Fetching latest refs from origin..."
git fetch --prune origin

# Avoid noisy executable bit drift when switching branches on Linux/Pi hosts.
git config --local core.fileMode false

if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "[INFO] Checking out local branch ${BRANCH}"
  git checkout "${BRANCH}"
else
  echo "[INFO] Creating local branch ${BRANCH} tracking origin/${BRANCH}"
  git checkout -b "${BRANCH}" --track "origin/${BRANCH}"
fi

git branch --set-upstream-to="origin/${BRANCH}" "${BRANCH}" >/dev/null 2>&1 || true

echo "[INFO] Pulling latest commits for ${BRANCH} (fast-forward only)..."
git pull --ff-only origin "${BRANCH}"

ACTIVE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ACTIVE_COMMIT="$(git rev-parse --short HEAD)"

echo "[OK] Active branch: ${ACTIVE_BRANCH}"
echo "[OK] HEAD commit: ${ACTIVE_COMMIT}"
