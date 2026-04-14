#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="bellforge.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_TARGET="/usr/local/bin/bellforge"
UNIT_SOURCE="${SCRIPT_DIR}/bellforge.service"
UNIT_TARGET="/etc/systemd/system/${SERVICE_NAME}"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "This installer must run as root." >&2
    echo "Use: sudo bash scripts/install_service.sh" >&2
    exit 1
  fi
}

install_binary() {
  cat > "${INSTALL_TARGET}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ -x /opt/bellforge/.venv/bin/python ]]; then
  exec /opt/bellforge/.venv/bin/python /opt/bellforge/scripts/bellforge_cli.py "$@"
fi

exec /usr/bin/env python3 /opt/bellforge/scripts/bellforge_cli.py "$@"
EOF

  chmod 0755 "${INSTALL_TARGET}"
  echo "Installed binary: ${INSTALL_TARGET}"
}

install_state_dir() {
  mkdir -p /var/lib/bellforge
  chown root:root /var/lib/bellforge
  chmod 0755 /var/lib/bellforge
  echo "Prepared state directory: /var/lib/bellforge"
}

install_service_unit() {
  if [[ ! -f "${UNIT_SOURCE}" ]]; then
    echo "Missing unit source file: ${UNIT_SOURCE}" >&2
    exit 1
  fi

  cp "${UNIT_SOURCE}" "${UNIT_TARGET}"
  chmod 0644 "${UNIT_TARGET}"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
  echo "Installed and started service: ${SERVICE_NAME}"
}

verify_installation() {
  local checks_passed=0
  local checks_total=4

  echo
  echo "Running verify_installation()"

  if "${INSTALL_TARGET}" doctor --service "${SERVICE_NAME}"; then
    echo "[PASS] bellforge doctor"
    checks_passed=$((checks_passed + 1))
  else
    echo "[FAIL] bellforge doctor"
  fi

  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "[PASS] service is active"
    checks_passed=$((checks_passed + 1))
  else
    echo "[FAIL] service is not active"
  fi

  local service_user
  service_user="$(systemctl show "${SERVICE_NAME}" --property=User --value || true)"
  if [[ -z "${service_user}" || "${service_user}" == "root" ]]; then
    echo "[PASS] service configured to run as root"
    checks_passed=$((checks_passed + 1))
  else
    echo "[FAIL] service user is '${service_user}'"
  fi

  local main_pid
  main_pid="$(systemctl show "${SERVICE_NAME}" --property=MainPID --value || true)"
  if [[ -n "${main_pid}" && "${main_pid}" != "0" && -r "/proc/${main_pid}/status" ]]; then
    local uid_line
    uid_line="$(awk '/^Uid:/ {print $2}' "/proc/${main_pid}/status")"
    if [[ "${uid_line}" == "0" ]]; then
      echo "[PASS] running process effective uid is 0"
      checks_passed=$((checks_passed + 1))
    else
      echo "[FAIL] running process uid is ${uid_line}"
    fi
  else
    echo "[FAIL] unable to inspect MainPID for ${SERVICE_NAME}"
  fi

  echo
  if [[ "${checks_passed}" -eq "${checks_total}" ]]; then
    echo "FINAL RESULT: SUCCESS (${checks_passed}/${checks_total} checks passed)"
    return 0
  fi

  echo "FINAL RESULT: FAIL (${checks_passed}/${checks_total} checks passed)"
  return 1
}

main() {
  require_root

  if [[ ! -d "/opt/bellforge" ]]; then
    echo "Expected /opt/bellforge to exist before installing service." >&2
    echo "Deploy BellForge first, then rerun this script." >&2
    exit 1
  fi

  install_binary
  install_state_dir
  install_service_unit
  verify_installation
}

main "$@"
