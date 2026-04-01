#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/opt/bellforge"
LOG_FILE="/var/log/bellforge-repair.log"
SERVICE_USER="bellforge"
SERVICE_GROUP="bellforge"
ASSUME_YES="false"

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "BellForge repair needs root privileges (or sudo installed)." >&2
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
      --yes|-y) ASSUME_YES="true" ;;
      *) ;;
    esac
    shift
  done
}

validate_structure() {
  run mkdir -p "${INSTALL_DIR}"
  run mkdir -p "${INSTALL_DIR}/config"
  run mkdir -p "${INSTALL_DIR}/scripts"
  run mkdir -p "${INSTALL_DIR}/updater"
  run mkdir -p "${INSTALL_DIR}/backend"
  run mkdir -p "${INSTALL_DIR}/client"
}

configure_network_permissions() {
  local sudoers_file="/etc/sudoers.d/bellforge-network"
  run bash -c "cat > '${sudoers_file}' <<'EOF'
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/nmcli
EOF"
  run chmod 0440 "${sudoers_file}"
}

validate_python() {
  if [[ ! -x "${INSTALL_DIR}/.venv/bin/python" ]]; then
    run python3 -m venv "${INSTALL_DIR}/.venv"
  fi

  if [[ ! -x "${INSTALL_DIR}/.venv/bin/pip" ]]; then
    run "${INSTALL_DIR}/.venv/bin/python" -m ensurepip --upgrade
  fi

  run "${INSTALL_DIR}/.venv/bin/python" -m pip install --upgrade pip
  run "${INSTALL_DIR}/.venv/bin/python" -m pip install -r "${INSTALL_DIR}/backend/requirements.txt"
  run "${INSTALL_DIR}/.venv/bin/python" -m pip install -r "${INSTALL_DIR}/updater/requirements.txt"
}

validate_services() {
  run install -m 0644 "${INSTALL_DIR}/scripts/bellforge-backend.service" /etc/systemd/system/bellforge-backend.service
  run install -m 0644 "${INSTALL_DIR}/scripts/bellforge-client.service" /etc/systemd/system/bellforge-client.service
  run install -m 0644 "${INSTALL_DIR}/scripts/bellforge-updater.service" /etc/systemd/system/bellforge-updater.service
  run systemctl daemon-reload
  run systemctl enable bellforge-backend.service bellforge-client.service bellforge-updater.service
}

validate_config_files() {
  if [[ ! -f "${INSTALL_DIR}/config/version.json" ]]; then
    log "version.json missing; updater will restore from remote on next cycle"
    echo '{"version":"0.0.0"}' | run tee "${INSTALL_DIR}/config/version.json" >/dev/null
  fi

  if [[ ! -f "${INSTALL_DIR}/config/manifest.json" ]]; then
    log "manifest.json missing; creating empty placeholder"
    echo '{"version":"0.0.0","files":{}}' | run tee "${INSTALL_DIR}/config/manifest.json" >/dev/null
  fi
}

validate_log_targets() {
  local updater_log_file="/var/log/bellforge-updater.log"
  run mkdir -p "$(dirname "${updater_log_file}")"
  run touch "${updater_log_file}"
  run chown "${SERVICE_USER}:${SERVICE_GROUP}" "${updater_log_file}"
}

validate_chromium() {
  if ! command -v cec-client >/dev/null 2>&1; then
    run env DEBIAN_FRONTEND=noninteractive apt-get update -y
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y cec-utils
  fi

  if ! dpkg -l lightdm >/dev/null 2>&1; then
    run env DEBIAN_FRONTEND=noninteractive apt-get update -y
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y lightdm
  fi

  if ! command -v chromium-browser >/dev/null 2>&1; then
    local chromium_pkg="chromium-browser"
    if apt-cache policy chromium-browser 2>/dev/null | grep -q "Candidate: (none)"; then
      chromium_pkg="chromium"
    fi

    run env DEBIAN_FRONTEND=noninteractive apt-get update -y
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${chromium_pkg}"
  fi

  if ! command -v openbox >/dev/null 2>&1 || ! command -v unclutter >/dev/null 2>&1; then
    run env DEBIAN_FRONTEND=noninteractive apt-get update -y
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y openbox unclutter xinit xserver-xorg
  fi
}

validate_kiosk_boot() {
  local kiosk_user="${SERVICE_USER}"
  local autostart_dir="/home/${kiosk_user}/.config/openbox"
  local autostart_file="${autostart_dir}/autostart"
  local client_env_path="${INSTALL_DIR}/config/client.env"

  run mkdir -p "${autostart_dir}"

  # Always rewrite openbox autostart so the kiosk launch line is present.
  run bash -c "cat > '${autostart_file}' <<'EOF'
# Disable screen blanking and power saving while in kiosk mode.
xset s off
xset -dpms
xset s noblank

# Hide the cursor when idle.
unclutter -idle 5 -root &

# Chromium kiosk launch is managed by bellforge-client.service
EOF"

  # Write Xorg config pointing kms to card1 (displays on Pi5 are on card1, not card0).
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

  if [[ ! -f "${client_env_path}" ]]; then
    run bash -c "cat > '${client_env_path}' <<EOF
BELLFORGE_KIOSK_URL=http://127.0.0.1:8000/client/index.html
BELLFORGE_CEC_POWER_ON=1
BELLFORGE_HDMI_WAIT_SECONDS=45
BELLFORGE_X_WAIT_SECONDS=45
EOF"
  fi

  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"
  run chown -R "${kiosk_user}:${SERVICE_GROUP}" "/home/${kiosk_user}/.config"
}

validate_rpi_firmware() {
  # Only apply on Raspberry Pi hardware.
  local model_file="/proc/device-tree/model"
  if [[ ! -f "${model_file}" ]] || ! grep -qi "Raspberry Pi" "${model_file}" 2>/dev/null; then
    return 0
  fi

  local config_file="/boot/firmware/config.txt"
  [[ -f "${config_file}" ]] || config_file="/boot/config.txt"
  [[ -f "${config_file}" ]] || return 0

  log "Validating Raspberry Pi firmware settings"

  if [[ ! -f "${config_file}.bellforge.bak" ]]; then
    run cp "${config_file}" "${config_file}.bellforge.bak"
  fi

  if grep -q "dtoverlay=vc4-kms-v3d" "${config_file}" && ! grep -q "dtoverlay=vc4-fkms-v3d" "${config_file}"; then
    run sed -i 's/dtoverlay=vc4-kms-v3d/dtoverlay=vc4-fkms-v3d/g' "${config_file}"
    log "Switched GPU overlay to vc4-fkms-v3d"
  elif ! grep -q "dtoverlay=vc4-fkms-v3d" "${config_file}"; then
    run bash -c "echo 'dtoverlay=vc4-fkms-v3d' >> '${config_file}'"
    log "Added vc4-fkms-v3d overlay"
  fi

  if ! grep -q "hdmi_force_hotplug" "${config_file}"; then
    run bash -c "echo 'hdmi_force_hotplug=1' >> '${config_file}'"
    log "Added hdmi_force_hotplug=1"
  fi
}

repair_from_manifest() {
  local settings_path="${INSTALL_DIR}/config/settings.json"
  if [[ ! -f "${settings_path}" ]]; then
    log "settings.json missing, skipping manifest repair step"
    return
  fi

  local update_base_url
  update_base_url="$(${INSTALL_DIR}/.venv/bin/python - <<'PY'
import json
from pathlib import Path
path = Path('/opt/bellforge/config/settings.json')
if path.exists():
    print(json.loads(path.read_text()).get('update_base_url', ''))
PY
)"

  if [[ -z "${update_base_url}" ]]; then
    log "update_base_url missing in settings.json; skipping manifest repair step"
    return
  fi

  run "${INSTALL_DIR}/.venv/bin/python" - <<'PY'
import hashlib
import json
import sys
from pathlib import Path
from urllib.request import urlopen

install_dir = Path('/opt/bellforge')
settings = json.loads((install_dir / 'config' / 'settings.json').read_text())
base_url = settings['update_base_url'].rstrip('/')

version = json.loads(urlopen(f"{base_url}/config/version.json", timeout=30).read().decode('utf-8'))
manifest = json.loads(urlopen(f"{base_url}/config/manifest.json", timeout=30).read().decode('utf-8'))

for rel_path, meta in manifest.get('files', {}).items():
    target = install_dir / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    needs_download = not target.is_file()

    if target.is_file():
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest != meta.get('sha256', ''):
            needs_download = True

    if needs_download:
        data = urlopen(f"{base_url}/{rel_path}", timeout=60).read()
        target.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        if digest != meta.get('sha256', ''):
            raise RuntimeError(f"Hash mismatch while repairing {rel_path}")

(install_dir / 'config' / 'version.json').write_text(json.dumps(version, indent=2), encoding='utf-8')
(install_dir / 'config' / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('Manifest integrity repair complete')
PY
}

restart_services() {
  run systemctl restart bellforge-backend.service
  run systemctl restart bellforge-client.service
  run systemctl restart bellforge-updater.service
}

main() {
  parse_args "$@"
  log "Starting BellForge repair"

  validate_structure
  configure_network_permissions
  validate_chromium
  validate_kiosk_boot
  validate_rpi_firmware
  validate_python
  validate_config_files
  validate_log_targets
  repair_from_manifest
  validate_services

  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"
  restart_services

  log "BellForge repair completed successfully"
}

main "$@"
