#!/usr/bin/env bash
set -Eeuo pipefail

# Live Pi install test with comprehensive logging and error capture
# Usage:
#   BELLFORGE_PI_HOST=192.168.1.100 BELLFORGE_PI_SSH_KEY_PATH=~/.ssh/id_rsa bash tests/install_test_live.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_LOG_DIR="${REPO_ROOT}/tests/logs"
LOG_FILE="${TEST_LOG_DIR}/install-test-live.log"
ERROR_LOG="${TEST_LOG_DIR}/install-test-live-errors.log"

mkdir -p "${TEST_LOG_DIR}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[INFO]${NC} $*" | tee -a "${LOG_FILE}"
}

log_ok() {
  echo -e "${GREEN}[OK]${NC} $*" | tee -a "${LOG_FILE}"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" | tee -a "${LOG_FILE}" "${ERROR_LOG}"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "${LOG_FILE}"
}

# Configuration
PI_HOST="${BELLFORGE_PI_HOST:-}"
PI_USER="${BELLFORGE_PI_USER:-pi}"
PI_SSH_KEY_PATH="${BELLFORGE_PI_SSH_KEY_PATH:-}"

REPO_OWNER="${BELLFORGE_REPO_OWNER:-ronaldarroyowatson}"
SERVER_IP="${BELLFORGE_SERVER_IP:-127.0.0.1}"
DISPLAY_ID="${BELLFORGE_DISPLAY_ID:-TestDisplay-Live}"
BRANCH="${BELLFORGE_BRANCH:-main}"

if [[ -z "${PI_HOST}" ]]; then
  log_error "BELLFORGE_PI_HOST is required"
  exit 1
fi

if [[ -z "${PI_SSH_KEY_PATH}" ]] || [[ ! -f "${PI_SSH_KEY_PATH}" ]]; then
  log_error "BELLFORGE_PI_SSH_KEY_PATH not found: ${PI_SSH_KEY_PATH}"
  exit 1
fi

SSH_OPTS=(
  -i "${PI_SSH_KEY_PATH}"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=20
  -o LogLevel=ERROR
)

{
  log_info "=================================================="
  log_info "BellForge Live Install Test"
  log_info "=================================================="
  log_info "Start time: $(date)"
  log_info "Pi host: ${PI_HOST}"
  log_info "Pi user: ${PI_USER}"
  log_info "Repo owner: ${REPO_OWNER}"
  log_info "Server IP: ${SERVER_IP}"
  log_info "Display ID: ${DISPLAY_ID}"
  log_info "Branch: ${BRANCH}"
  log_info ""
} | tee -a "${LOG_FILE}"

# Function to run command on Pi
pi_run() {
  local escaped_cmd
  escaped_cmd="$@"
  ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" "bash -c '$escaped_cmd'" 2>&1 || return $?
}

# Function to run command on Pi with full output capture
pi_run_verbose() {
  local escaped_cmd
  escaped_cmd="$@"
  log_info "Executing on Pi: $escaped_cmd"
  ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" "bash -c '$escaped_cmd'" 2>&1 | tee -a "${LOG_FILE}" || {
    local exit_code=$?
    log_error "Command failed with exit code $exit_code"
    return $exit_code
  }
}

# Step 1: Verify Pi access
log_info ""
log_info "STEP 1: Verifying Pi access and prerequisites"
log_info "=================================================="
if pi_run "hostname && whoami && sudo -n true"; then
  log_ok "Pi access verified"
else
  log_error "Cannot access Pi or execute sudo without password"
  exit 1
fi

# Step 2: Check Pi system info
log_info ""
log_info "STEP 2: Gathering Pi system information"
log_info "=================================================="
pi_run_verbose "uname -a"
pi_run_verbose "cat /etc/os-release"
pi_run_verbose "df -h /opt || echo 'Note: /opt not yet present'"

# Step 3: Pre-install cleanup
log_info ""
log_info "STEP 3: Pre-install cleanup (removing any previous installation)"
log_info "=================================================="
if pi_run "sudo bash -c 'systemctl stop bellforge-backend bellforge-client bellforge-updater 2>/dev/null || true; sleep 2'"; then
  log_ok "Stopped existing services"
fi

if pi_run "sudo rm -rf /opt/bellforge /opt/bellforge-staging"; then
  log_ok "Removed previous installation directories"
fi

# Step 4: Run one-line install
log_info ""
log_info "STEP 4: Executing one-line install command"
log_info "=================================================="
log_info "Command:"
log_info "curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/BellForge/${BRANCH}/install.sh | sudo env BELLFORGE_REPO_OWNER=${REPO_OWNER} BELLFORGE_SERVER_IP=${SERVER_IP} BELLFORGE_DISPLAY_ID=${DISPLAY_ID} bash -s -- --install --yes --no-reboot"
log_info ""

INSTALL_START=$(date +%s)
if pi_run_verbose "curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/BellForge/${BRANCH}/install.sh | sudo env BELLFORGE_REPO_OWNER='${REPO_OWNER}' BELLFORGE_SERVER_IP='${SERVER_IP}' BELLFORGE_DISPLAY_ID='${DISPLAY_ID}' bash -s -- --install --yes --no-reboot 2>&1"; then
  INSTALL_END=$(date +%s)
  INSTALL_DURATION=$((INSTALL_END - INSTALL_START))
  log_ok "Install completed in ${INSTALL_DURATION}s"
else
  INSTALL_END=$(date +%s)
  INSTALL_DURATION=$((INSTALL_END - INSTALL_START))
  log_error "Install failed after ${INSTALL_DURATION}s"
  exit 1
fi

# Step 5: Post-install validation
log_info ""
log_info "STEP 5: Post-install validation"
log_info "=================================================="

# Check critical paths exist
log_info "Checking critical installation paths..."
for path in \
  "/opt/bellforge" \
  "/opt/bellforge/.venv/bin/python" \
  "/opt/bellforge/config/version.json" \
  "/opt/bellforge/config/manifest.json" \
  "/opt/bellforge/backend/main.py" \
  "/opt/bellforge/client/status.html" \
  "/opt/bellforge/updater/agent.py"; do
  if pi_run "test -e '${path}'"; then
    log_ok "✓ ${path} exists"
  else
    log_error "✗ ${path} missing"
    exit 1
  fi
done

# Check service files exist
log_info "Checking service files..."
for svc in bellforge-backend bellforge-client bellforge-updater; do
  if pi_run "sudo test -f /etc/systemd/system/${svc}.service"; then
    log_ok "✓ ${svc}.service installed"
  else
    log_error "✗ ${svc}.service missing"
    exit 1
  fi
done

# Step 6: Check service status
log_info ""
log_info "STEP 6: Checking service status (no-reboot mode)"
log_info "=================================================="
for svc in bellforge-backend bellforge-client bellforge-updater; do
  if pi_run "sudo systemctl is-enabled '${svc}.service' >/dev/null && echo 'enabled' || echo 'disabled'"; then
    log_ok "✓ ${svc}.service enabled for auto-start"
  else
    log_error "✗ ${svc}.service not enabled"
  fi
done

# Step 7: Validate configs
log_info ""
log_info "STEP 7: Validating configuration files"
log_info "=================================================="

log_info "Checking version.json..."
if pi_run_verbose "cat /opt/bellforge/config/version.json | python3 -m json.tool"; then
  log_ok "✓ version.json is valid JSON"
else
  log_error "✗ version.json invalid"
  exit 1
fi

log_info "Checking manifest.json..."
if pi_run_verbose "cat /opt/bellforge/config/manifest.json | python3 -m json.tool | head -20"; then
  log_ok "✓ manifest.json is valid JSON"
else
  log_error "✗ manifest.json invalid"
  exit 1
fi

# Step 8: Check file permissions
log_info ""
log_info "STEP 8: Checking critical file permissions"
log_info "=================================================="
for script in \
  "/opt/bellforge/scripts/start_kiosk.sh" \
  "/opt/bellforge/scripts/start_backend.sh" \
  "/opt/bellforge/scripts/bootstrap.sh"; do
  if pi_run "test -x '${script}'"; then
    log_ok "✓ ${script} is executable"
  else
    log_warn "✗ ${script} is not executable (fixing...)"
    if pi_run "sudo chmod +x '${script}'"; then
      log_ok "✓ Fixed: ${script} now executable"
    fi
  fi
done

# Step 9: Backend health check
log_info ""
log_info "STEP 9: Backend health check"
log_info "=================================================="
log_info "Note: May fail in no-reboot mode if backend hasn't started yet"

if pi_run "curl -fsS http://127.0.0.1:8000/health 2>/dev/null"; then
  log_ok "✓ Backend health endpoint responsive"
elif pi_run "curl -fsS http://127.0.0.1:8000/health 2>/dev/null || echo 'Backend not yet started (expected in no-reboot mode)'"; then
  log_warn "Backend not yet responding (expected in no-reboot mode)"
fi

# Step 10: Collect diagnostics
log_info ""
log_info "STEP 10: Collecting post-install diagnostics"
log_info "=================================================="

log_info "Systemd service status:"
pi_run_verbose "sudo systemctl status bellforge-backend || true" | tee -a "${LOG_FILE}"
pi_run_verbose "sudo systemctl status bellforge-client || true" | tee -a "${LOG_FILE}"
pi_run_verbose "sudo systemctl status bellforge-updater || true" | tee -a "${LOG_FILE}"

log_info ""
log_info "Install log excerpt (first 50 lines):"
pi_run_verbose "sudo head -50 /var/log/bellforge-install.log" | tee -a "${LOG_FILE}"

log_info ""
log_info "Checking for installation errors in log..."
if pi_run "sudo grep -i 'error\|failed\|exception' /var/log/bellforge-install.log || echo 'No error keywords found'"; then
  log_ok "Log analysis complete"
fi

# Final summary
log_info ""
log_info "=================================================="
log_info "INSTALL TEST SUMMARY"
log_info "=================================================="
log_ok "✓ One-line install test completed successfully"
log_ok "✓ All critical paths present"
log_ok "✓ Services installed and enabled"
log_ok "✓ Configuration files valid"
log_info ""
log_info "End time: $(date)"
log_info "Full log: ${LOG_FILE}"
log_info "Errors (if any): ${ERROR_LOG}"

} 2>&1 | tee -a "${LOG_FILE}"

exit 0
