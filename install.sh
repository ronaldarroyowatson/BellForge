#!/usr/bin/env bash
set -Eeuo pipefail

# BellForge unified installer and manager.
# One-line usage:
#   curl -sSL https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/main/install.sh | bash
#
# Optional flags:
#   --install       Force fresh install path
#   --repair        Run repair path
#   --reinstall     Reinstall (uninstall then install)
#   --uninstall     Uninstall BellForge
#   --purge         Used with --uninstall/--reinstall, removes extra user data
#   --yes           Auto-confirm prompts
#   --no-reboot     Complete action without reboot (for automated tests)

INSTALL_DIR="/opt/bellforge"
SERVICE_USER="bellforge"
SERVICE_GROUP="bellforge"
LOG_FILE="/var/log/bellforge-install.log"
BRANCH="${BELLFORGE_BRANCH:-main}"
REPO_OWNER="${BELLFORGE_REPO_OWNER:-ronaldarroyowatson}"
REPO_URL="${BELLFORGE_REPO_URL:-https://github.com/${REPO_OWNER}/BellForge.git}"
UPDATE_BASE_URL="${BELLFORGE_UPDATE_BASE_URL:-https://raw.githubusercontent.com/${REPO_OWNER}/BellForge/${BRANCH}}"
SERVER_IP="${BELLFORGE_SERVER_IP:-127.0.0.1}"
DISPLAY_ID="${BELLFORGE_DISPLAY_ID:-main}"

ACTION="auto"
PURGE="false"
ASSUME_YES="false"
NEEDS_REBOOT="false"
NO_REBOOT="false"

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "BellForge installer needs root privileges. Run as root or install sudo." >&2
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

run_as_service_user() {
  log "(as ${SERVICE_USER}) $*"
  if [[ "${EUID}" -eq 0 ]]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "${SERVICE_USER}" -- "$@"
    else
      sudo -u "${SERVICE_USER}" "$@"
    fi
  elif [[ -n "${SUDO}" ]]; then
    ${SUDO} -u "${SERVICE_USER}" "$@"
  else
    "$@"
  fi
}

friendly() {
  echo
  echo "==> $*"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install) ACTION="install" ;;
      --repair) ACTION="repair" ;;
      --reinstall) ACTION="reinstall" ;;
      --uninstall) ACTION="uninstall" ;;
      --purge) PURGE="true" ;;
      --yes|-y) ASSUME_YES="true" ;;
      --no-reboot) NO_REBOOT="true" ;;
      *)
        echo "Unknown flag: $1" >&2
        exit 2
        ;;
    esac
    shift
  done
}

confirm() {
  local prompt="$1"
  if [[ "${ASSUME_YES}" == "true" ]]; then
    return 0
  fi
  read -r -p "${prompt} [y/N]: " reply
  [[ "${reply}" =~ ^[Yy]$ ]]
}

ensure_user() {
  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    run useradd --system --create-home --shell /bin/bash "${SERVICE_USER}"
  fi
}

configure_self_heal_permissions() {
  local sudoers_file="/etc/sudoers.d/bellforge-self-heal"
  run bash -c "cat > '${sudoers_file}' <<'EOF'
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/nmcli
${SERVICE_USER} ALL=(root) NOPASSWD: /bin/systemctl
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl
${SERVICE_USER} ALL=(root) NOPASSWD: /sbin/reboot
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/reboot
EOF"
  run chmod 0440 "${sudoers_file}"
}

ensure_packages() {
  friendly "Installing required system packages"
  local chromium_pkg="chromium-browser"
  if apt-cache policy chromium-browser 2>/dev/null | grep -q "Candidate: (none)"; then
    chromium_pkg="chromium"
  fi

  run env DEBIAN_FRONTEND=noninteractive apt-get update -y
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    curl \
    git \
    python3 \
    python3-venv \
    python3-pip \
    cec-utils \
    lightdm \
    "${chromium_pkg}" \
    openbox \
    unclutter \
    systemd \
    xserver-xorg \
    xinit
}

configure_kiosk_boot() {
  local kiosk_user="${SERVICE_USER}"
  local autostart_dir="/home/${kiosk_user}/.config/openbox"
  local autostart_file="${autostart_dir}/autostart"

  run mkdir -p "${autostart_dir}"

  # Openbox autostart: disable screen saver, hide cursor, and launch kiosk.
  run bash -c "cat > '${autostart_file}' <<'EOF'
# Disable screen blanking and power saving while in kiosk mode.
xset s off
xset -dpms
xset s noblank

# Hide the cursor when idle.
unclutter -idle 5 -root &

# Chromium kiosk launch is managed by bellforge-client.service
[[ -f /opt/bellforge/config/client.env ]] && . /opt/bellforge/config/client.env
EOF"

  # Write Xorg config pointing kms to card1 (displays on Pi5 are on card1, not card0).
  # Guard on card1 existing so we don't break non-Pi hardware.
  if [[ -e /dev/dri/card1 ]]; then
    run python3 - <<'PYEOF'
import pathlib
q = chr(34)
content = f"""\
Section {q}Device{q}
  Identifier {q}kms-card1{q}
  Driver {q}modesetting{q}
  Option {q}kmsdev{q} {q}/dev/dri/card1{q}
  Option {q}AccelMethod{q} {q}glamor{q}
  Option {q}AutoAddGPU{q} {q}false{q}
EndSection

Section {q}ServerFlags{q}
  Option {q}AutoAddGPU{q} {q}false{q}
EndSection
"""
pathlib.Path("/etc/X11").mkdir(parents=True, exist_ok=True)
pathlib.Path("/etc/X11/xorg.conf").write_text(content)
PYEOF
  fi

  # LightDM autologin for the BellForge display user.
  run mkdir -p /etc/lightdm/lightdm.conf.d
  run bash -c "cat > /etc/lightdm/lightdm.conf.d/12-bellforge-autologin.conf <<EOF
[SeatDefaults]
autologin-user=${kiosk_user}
autologin-session=openbox
minimum-uid=0
EOF"

  # Ensure the kiosk user has access to display and input devices.
  for grp in tty video render input audio; do
    if getent group "\${grp}" >/dev/null 2>&1; then
      run usermod -aG "\${grp}" "${kiosk_user}" || true
    fi
  done

  # Boot into graphical target and enable LightDM.
  run systemctl set-default graphical.target
  run systemctl enable lightdm.service

  # Clean up any stale autologin override from older installs to avoid tty login loops.
  run rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
  run systemctl daemon-reload
  run systemctl reset-failed getty@tty1.service || true

  run chown -R "${kiosk_user}:${SERVICE_GROUP}" "/home/${kiosk_user}/.config"
}

configure_rpi_firmware() {
  # Only apply on Raspberry Pi hardware.
  local model_file="/proc/device-tree/model"
  if [[ ! -f "${model_file}" ]] || ! grep -qi "Raspberry Pi" "${model_file}" 2>/dev/null; then
    return 0
  fi

  local config_file="/boot/firmware/config.txt"
  [[ -f "${config_file}" ]] || config_file="/boot/config.txt"
  [[ -f "${config_file}" ]] || return 0

  friendly "Configuring Raspberry Pi firmware for kiosk display"

  # Back up config.txt once so it can be restored manually if needed.
  if [[ ! -f "${config_file}.bellforge.bak" ]]; then
    run cp "${config_file}" "${config_file}.bellforge.bak"
  fi

  # Switch from kms-v3d to fkms-v3d for reliable HDMI output via modesetting driver.
  if grep -q "dtoverlay=vc4-kms-v3d" "${config_file}" && ! grep -q "dtoverlay=vc4-fkms-v3d" "${config_file}"; then
    run sed -i 's/dtoverlay=vc4-kms-v3d/dtoverlay=vc4-fkms-v3d/g' "${config_file}"
    log "Switched GPU overlay to vc4-fkms-v3d"
  elif ! grep -q "dtoverlay=vc4-fkms-v3d" "${config_file}"; then
    run bash -c "echo 'dtoverlay=vc4-fkms-v3d' >> '${config_file}'"
    log "Added vc4-fkms-v3d overlay"
  fi

  # Ensure HDMI hot-plug detection is enabled (prevents Pi ignoring TV on first boot).
  if ! grep -q "hdmi_force_hotplug" "${config_file}"; then
    run bash -c "echo 'hdmi_force_hotplug=1' >> '${config_file}'"
    log "Added hdmi_force_hotplug=1"
  fi
}

write_local_config() {
  local settings_path="${INSTALL_DIR}/config/settings.json"
  local client_env_path="${INSTALL_DIR}/config/client.env"
  local tmp

  run mkdir -p "${INSTALL_DIR}/config"

  if [[ ! -f "${settings_path}" ]]; then
    tmp="$(mktemp)"
    cat > "${tmp}" <<JSON
{
  "update_base_url": "${UPDATE_BASE_URL}",
  "poll_interval_seconds": 300,
  "trigger_port": 8765,
  "install_dir": "${INSTALL_DIR}",
  "staging_dir": "${INSTALL_DIR}/.staging",
  "log_file": "/var/log/bellforge-updater.log",
  "max_retries": 3,
  "retry_delay_seconds": 20,
  "auto_reboot_after_update": true,
  "device_id": "${DISPLAY_ID}",
  "services_to_restart": [
    "bellforge-backend.service",
    "bellforge-client.service"
  ],
  "preserve_local_paths": [
    "config/settings.json",
    "config/client.env"
  ]
}
JSON
    run cp "${tmp}" "${settings_path}"
    rm -f "${tmp}"
  fi

  if [[ ! -f "${client_env_path}" ]]; then
    run bash -c "cat > '${client_env_path}' <<EOF
BELLFORGE_KIOSK_URL=http://127.0.0.1:8000/client/index.html
BELLFORGE_CEC_POWER_ON=1
BELLFORGE_HDMI_WAIT_SECONDS=45
BELLFORGE_X_WAIT_SECONDS=45
EOF"
  fi

  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}/config"
}

setup_updater_log_file() {
  local updater_log_file="/var/log/bellforge-updater.log"
  run mkdir -p "$(dirname "${updater_log_file}")"
  run touch "${updater_log_file}"
  run chown "${SERVICE_USER}:${SERVICE_GROUP}" "${updater_log_file}"
}

setup_debug_log_file() {
  local debug_log_file="/var/log/bellforge-debug.jsonl"
  run mkdir -p "$(dirname "${debug_log_file}")"
  run touch "${debug_log_file}"
  run chown "${SERVICE_USER}:${SERVICE_GROUP}" "${debug_log_file}"
}

setup_cli_command() {
  local cli_wrapper="${INSTALL_DIR}/scripts/bellforge"
  run chmod +x "${cli_wrapper}"
  run ln -sf "${cli_wrapper}" /usr/local/bin/bellforge
}

sync_repo() {
  friendly "Synchronizing BellForge repository"

  # Local-path repo URLs used by tests can be owned by another user.
  # Register them as safe for the service user before git fetch/clone.
  if [[ "${REPO_URL}" = /* ]] && [[ -d "${REPO_URL}" ]]; then
    run_as_service_user git config --global --add safe.directory "${REPO_URL}" || true
    if [[ -d "${REPO_URL}/.git" ]]; then
      run_as_service_user git config --global --add safe.directory "${REPO_URL}/.git" || true
    fi
  fi

  run mkdir -p "${INSTALL_DIR}"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    run_as_service_user git -C "${INSTALL_DIR}" fetch --all --prune
    run_as_service_user git -C "${INSTALL_DIR}" checkout "${BRANCH}"
    run_as_service_user git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
  else
    run rm -rf "${INSTALL_DIR}"
    run install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${INSTALL_DIR}"
    run_as_service_user git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  fi

  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"
  
  # Ensure all shell scripts are executable.
  run find "${INSTALL_DIR}/scripts" -type f -name "*.sh" -exec chmod 0755 {} \;
}

setup_python() {
  friendly "Validating Python virtual environment"
  if [[ ! -x "${INSTALL_DIR}/.venv/bin/python" ]]; then
    run python3 -m venv "${INSTALL_DIR}/.venv"
  fi

  # Runtime dependency guard writes a stamp file under .venv at service start.
  # Keep ownership aligned with the service account to avoid PermissionError.
  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}/.venv"

  if [[ ! -x "${INSTALL_DIR}/.venv/bin/pip" ]]; then
    run "${INSTALL_DIR}/.venv/bin/python" -m ensurepip --upgrade
  fi

  run "${INSTALL_DIR}/.venv/bin/python" -m pip install --upgrade pip
  run "${INSTALL_DIR}/.venv/bin/python" -m pip install -r "${INSTALL_DIR}/backend/requirements.txt"
  run "${INSTALL_DIR}/.venv/bin/python" -m pip install -r "${INSTALL_DIR}/updater/requirements.txt"

  # pip may create root-owned cache/metadata paths when invoked by installer.
  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}/.venv"
}

install_services() {
  friendly "Installing and starting BellForge services"
  run install -m 0644 "${INSTALL_DIR}/scripts/bellforge-backend.service" /etc/systemd/system/bellforge-backend.service
  run install -m 0644 "${INSTALL_DIR}/scripts/bellforge-client.service" /etc/systemd/system/bellforge-client.service
  run install -m 0644 "${INSTALL_DIR}/scripts/bellforge-updater.service" /etc/systemd/system/bellforge-updater.service

  run systemctl daemon-reload
  run systemctl enable bellforge-backend.service bellforge-client.service bellforge-updater.service
  run systemctl restart bellforge-backend.service bellforge-client.service bellforge-updater.service
}

is_installed() {
  [[ -d "${INSTALL_DIR}" ]] && [[ -f "${INSTALL_DIR}/config/version.json" ]]
}

is_healthy() {
  [[ -d "${INSTALL_DIR}" ]] || return 1
  [[ -x "${INSTALL_DIR}/.venv/bin/python" ]] || return 1
  [[ -f "${INSTALL_DIR}/updater/agent.py" ]] || return 1
  [[ -f "${INSTALL_DIR}/config/version.json" ]] || return 1
  [[ -f "${INSTALL_DIR}/config/manifest.json" ]] || return 1

  for svc in bellforge-backend.service bellforge-client.service bellforge-updater.service; do
    systemctl cat "${svc}" >/dev/null 2>&1 || return 1
  done
  return 0
}

run_repair() {
  friendly "Starting BellForge repair"
  if [[ -f "${INSTALL_DIR}/scripts/repair.sh" ]]; then
    if [[ -n "${SUDO}" ]]; then
      ${SUDO} bash "${INSTALL_DIR}/scripts/repair.sh" --yes
    else
      bash "${INSTALL_DIR}/scripts/repair.sh" --yes
    fi
  else
    log "repair.sh missing; performing install workflow as recovery"
    do_install
  fi
}

run_uninstall() {
  local no_reboot="${1:-false}"
  friendly "Starting BellForge uninstall"
  if [[ -f "${INSTALL_DIR}/scripts/uninstall.sh" ]]; then
    if [[ -n "${SUDO}" ]]; then
      ${SUDO} bash "${INSTALL_DIR}/scripts/uninstall.sh" $( [[ "${PURGE}" == "true" ]] && echo "--purge" ) $( [[ "${no_reboot}" == "true" ]] && echo "--no-reboot" ) --yes
    else
      bash "${INSTALL_DIR}/scripts/uninstall.sh" $( [[ "${PURGE}" == "true" ]] && echo "--purge" ) $( [[ "${no_reboot}" == "true" ]] && echo "--no-reboot" ) --yes
    fi
  else
    log "uninstall.sh missing; fallback uninstall"
    for svc in bellforge-updater.service bellforge-client.service bellforge-backend.service bellforge-file-server.service; do
      run systemctl stop "${svc}" || true
      run systemctl disable "${svc}" || true
      run rm -f "/etc/systemd/system/${svc}"
    done
    run systemctl daemon-reload
    run rm -rf "${INSTALL_DIR}"
    run rm -f /var/log/bellforge-*
    if [[ "${PURGE}" == "true" ]]; then
      run rm -rf /var/lib/bellforge /opt/bellforge-data
    fi
  fi
}

do_install() {
  ensure_packages
  ensure_user
  configure_self_heal_permissions
  sync_repo
  setup_python
  write_local_config
  setup_updater_log_file
  setup_debug_log_file
  setup_cli_command
  configure_kiosk_boot
  configure_rpi_firmware
  install_services
  NEEDS_REBOOT="true"
}

do_reinstall() {
  run_uninstall "true"
  do_install
}

choose_action_interactive() {
  local broken="$1"

  if [[ "${ASSUME_YES}" == "true" ]]; then
    if [[ "${broken}" == "true" ]]; then
      ACTION="repair"
    else
      ACTION="repair"
    fi
    return
  fi

  if [[ "${broken}" == "true" ]]; then
    echo
    echo "BellForge is installed but appears broken or incomplete."
    echo "1) Repair (recommended)"
    echo "2) Reinstall"
    echo "3) Uninstall"
    echo "4) Cancel"
  else
    echo
    echo "BellForge is already installed and healthy."
    echo "1) Repair"
    echo "2) Reinstall"
    echo "3) Uninstall"
    echo "4) Cancel"
  fi

  read -r -p "Choose an option [1-4]: " choice
  case "${choice}" in
    1) ACTION="repair" ;;
    2) ACTION="reinstall" ;;
    3) ACTION="uninstall" ;;
    *) ACTION="cancel" ;;
  esac
}

main() {
  parse_args "$@"

  friendly "BellForge setup manager"
  log "repo=${REPO_URL} branch=${BRANCH} action=${ACTION}"

  if [[ "${ACTION}" == "auto" ]]; then
    if ! is_installed; then
      ACTION="install"
      log "No existing install detected. Running fresh installation."
    elif is_healthy; then
      choose_action_interactive "false"
    else
      choose_action_interactive "true"
    fi
  fi

  case "${ACTION}" in
    install)
      do_install
      ;;
    repair)
      run_repair
      ;;
    reinstall)
      do_reinstall
      ;;
    uninstall)
      run_uninstall "true"
      NEEDS_REBOOT="true"
      ;;
    cancel)
      friendly "No changes were made."
      exit 0
      ;;
    *)
      echo "Invalid action: ${ACTION}" >&2
      exit 2
      ;;
  esac

  if [[ "${NEEDS_REBOOT}" == "true" && "${NO_REBOOT}" != "true" ]]; then
    friendly "BellForge action completed. System will reboot in 10 seconds."
    sleep 10
    run reboot
  elif [[ "${NEEDS_REBOOT}" == "true" && "${NO_REBOOT}" == "true" ]]; then
    friendly "BellForge action completed. Reboot skipped (--no-reboot)."
  else
    friendly "BellForge action completed."
  fi
}

main "$@"
