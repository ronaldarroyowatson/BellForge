#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_LOG_DIR="${REPO_ROOT}/tests/logs"
LOG_FILE="${TEST_LOG_DIR}/live-pi-lifecycle.log"

mkdir -p "${TEST_LOG_DIR}"
exec > >(tee "${LOG_FILE}") 2>&1

PI_HOST="${BELLFORGE_PI_HOST:-}"
PI_USER="${BELLFORGE_PI_USER:-pi}"
PI_SSH_KEY_PATH="${BELLFORGE_PI_SSH_KEY_PATH:-}"

REPO_OWNER="${BELLFORGE_REPO_OWNER:-ronaldarroyowatson}"
SERVER_IP="${BELLFORGE_SERVER_IP:-127.0.0.1}"
DISPLAY_ID="${BELLFORGE_DISPLAY_ID:-CI-LIVE}"
INSTALLER_URL="${BELLFORGE_INSTALLER_URL:-https://raw.githubusercontent.com/${REPO_OWNER}/BellForge/main/install.sh}"

if [[ -z "${PI_HOST}" || -z "${PI_SSH_KEY_PATH}" ]]; then
  echo "[FAIL] Missing required env vars: BELLFORGE_PI_HOST and BELLFORGE_PI_SSH_KEY_PATH"
  exit 2
fi

SSH_OPTS=(
  -i "${PI_SSH_KEY_PATH}"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=20
)

ssh_run() {
  ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" "$@"
}

echo "[INFO] Verifying Pi access and sudo permissions"
ssh_run "set -euo pipefail; hostname; whoami; sudo -n true"

echo "[INFO] Running full live lifecycle test on Pi"
ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" "bash -s" <<EOF
set -Eeuo pipefail

REPO_OWNER="${REPO_OWNER}"
SERVER_IP="${SERVER_IP}"
DISPLAY_ID="${DISPLAY_ID}"
INSTALLER_URL="${INSTALLER_URL}"

run_action() {
  local action="\$1"
  shift
  curl -fsSL "\${INSTALLER_URL}" | sudo env \
    BELLFORGE_REPO_OWNER="\${REPO_OWNER}" \
    BELLFORGE_SERVER_IP="\${SERVER_IP}" \
    BELLFORGE_DISPLAY_ID="\${DISPLAY_ID}" \
    bash -s -- "\${action}" --yes --no-reboot "\$@"
}

assert_file() {
  local path="\$1"
  [[ -e "\${path}" ]] || { echo "[FAIL] Missing expected path: \${path}"; exit 1; }
}

assert_no_file() {
  local path="\$1"
  [[ ! -e "\${path}" ]] || { echo "[FAIL] Unexpected path still exists: \${path}"; exit 1; }
}

assert_service_state() {
  local svc="\$1"
  local state
  state="\$(systemctl is-active "\${svc}" || true)"
  if [[ "\${state}" != "active" && "\${state}" != "activating" ]]; then
    echo "[FAIL] Service \${svc} state=\${state}"
    exit 1
  fi
}

echo "[STEP] Pre-clean uninstall"
run_action --uninstall --purge

echo "[STEP] Fresh install"
run_action --install

echo "[STEP] Validate install"
assert_file /opt/bellforge
assert_file /opt/bellforge/.venv/bin/python
assert_file /opt/bellforge/config/version.json
assert_file /opt/bellforge/config/manifest.json
assert_service_state bellforge-backend.service
assert_service_state bellforge-client.service
assert_service_state bellforge-updater.service
curl -fsS http://127.0.0.1:8000/status >/dev/null

echo "[STEP] Inject repair damage"
sudo rm -f /etc/systemd/system/bellforge-client.service /etc/systemd/system/bellforge-updater.service
sudo systemctl daemon-reload
sudo rm -f /opt/bellforge/.venv/bin/pip
echo '{"corrupt": true' | sudo tee /opt/bellforge/config/manifest.json >/dev/null
sudo rm -f /opt/bellforge/backend/main.py /opt/bellforge/client/status.html /opt/bellforge/updater/agent.py

echo "[STEP] Repair"
run_action --repair

echo "[STEP] Validate repair"
assert_file /opt/bellforge/backend/main.py
assert_file /opt/bellforge/client/status.html
assert_file /opt/bellforge/updater/agent.py
assert_file /etc/systemd/system/bellforge-client.service
assert_file /etc/systemd/system/bellforge-updater.service
assert_service_state bellforge-backend.service
assert_service_state bellforge-client.service
assert_service_state bellforge-updater.service
curl -fsS http://127.0.0.1:8000/status >/dev/null

echo "[STEP] Final uninstall"
run_action --uninstall --purge

echo "[STEP] Validate uninstall"
assert_no_file /opt/bellforge
if systemctl list-unit-files | grep -Eq '^bellforge-(backend|client|updater)\\.service'; then
  echo "[FAIL] BellForge service unit files still present"
  systemctl list-unit-files | grep -E '^bellforge-(backend|client|updater)\\.service' || true
  exit 1
fi

ps -eo args | grep -E '/opt/bellforge/.venv/bin/(uvicorn|python).*updater/agent.py|/opt/bellforge/.venv/bin/uvicorn' | grep -v grep && {
  echo "[FAIL] BellForge processes still running"
  exit 1
}

echo "[PASS] Live Pi lifecycle smoke test completed"
EOF

echo "[INFO] Collecting remote lifecycle logs"
mkdir -p "${TEST_LOG_DIR}/live-pi"
scp "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}:/var/log/bellforge-install.log" "${TEST_LOG_DIR}/live-pi/bellforge-install.log" || true
scp "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}:/var/log/bellforge-repair.log" "${TEST_LOG_DIR}/live-pi/bellforge-repair.log" || true
scp "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}:/var/log/bellforge-uninstall.log" "${TEST_LOG_DIR}/live-pi/bellforge-uninstall.log" || true

echo "[PASS] Live Pi lifecycle test completed successfully"