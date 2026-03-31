#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/opt/bellforge"
LOG_FILE="/var/log/bellforge-uninstall.log"
PURGE="false"
ASSUME_YES="false"
NO_REBOOT="false"

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -n"
  else
    echo "BellForge uninstall needs root privileges." >&2
    exit 1
  fi
fi

if [[ -n "${SUDO}" ]]; then
  exec > >(${SUDO} tee -a "${LOG_FILE}") 2>&1
else
  mkdir -p "$(dirname "${LOG_FILE}")"
  exec > >(tee -a "${LOG_FILE}") 2>&1
fi

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

run() {
  log "$*"
  if [[ -n "${SUDO}" ]]; then
    ${SUDO} "$@"
  else
    "$@"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge) PURGE="true" ;;
      --yes|-y) ASSUME_YES="true" ;;
      --no-reboot) NO_REBOOT="true" ;;
      *) ;;
    esac
    shift
  done
}

confirm() {
  if [[ "${ASSUME_YES}" == "true" ]]; then
    return 0
  fi
  read -r -p "This will uninstall BellForge. Continue? [y/N]: " reply
  [[ "${reply}" =~ ^[Yy]$ ]]
}

stop_and_remove_services() {
  for svc in bellforge-updater.service bellforge-client.service bellforge-backend.service; do
    run systemctl stop "${svc}" || true
    run systemctl disable "${svc}" || true
    run rm -f "/etc/systemd/system/${svc}"
  done
  run systemctl daemon-reload
}

remove_files() {
  run rm -rf "${INSTALL_DIR}"
  run rm -f /var/log/bellforge-*

  if [[ "${PURGE}" == "true" ]]; then
    run rm -rf /var/lib/bellforge /opt/bellforge-data
  fi
}

main() {
  parse_args "$@"

  if ! confirm; then
    log "Uninstall cancelled"
    exit 0
  fi

  log "Starting BellForge uninstall"
  stop_and_remove_services
  remove_files
  if [[ "${NO_REBOOT}" == "true" ]]; then
    log "BellForge uninstall completed"
  else
    log "BellForge uninstall completed; rebooting in 10 seconds"
    sleep 10
    run reboot
  fi
}

main "$@"
