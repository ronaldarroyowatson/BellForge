#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/opt/bellforge"
LOG_FILE="/var/log/bellforge-repair.log"
SERVICE_USER="bellforge"
SERVICE_GROUP="bellforge"
ASSUME_YES="false"

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -n"
  else
    echo "BellForge repair needs root privileges." >&2
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
  local autostart_dir="/home/${SERVICE_USER}/.config/openbox"
  local autostart_file="${autostart_dir}/autostart"
  local bashprofile="/home/${SERVICE_USER}/.bash_profile"
  local client_env_path="${INSTALL_DIR}/config/client.env"

  run mkdir -p "${autostart_dir}"
  run bash -c "cat > '${autostart_file}' <<'EOF'
# Disable screen blanking and power saving while in kiosk mode.
xset s off
xset -dpms
xset s noblank

# Hide the cursor when idle.
unclutter -idle 5 -root &
EOF"

  if [[ -n "${SUDO}" ]]; then
    if ! ${SUDO} grep -Fq "startx -- -nocursor" "${bashprofile}" 2>/dev/null; then
      run bash -c "echo '[[ -z \$DISPLAY && \$XDG_VTNR -eq 1 ]] && exec startx -- -nocursor' >> '${bashprofile}'"
    fi
  else
    if ! grep -Fq "startx -- -nocursor" "${bashprofile}" 2>/dev/null; then
      run bash -c "echo '[[ -z \$DISPLAY && \$XDG_VTNR -eq 1 ]] && exec startx -- -nocursor' >> '${bashprofile}'"
    fi
  fi

  run mkdir -p /etc/systemd/system/getty@tty1.service.d
  run bash -c "cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${SERVICE_USER} --noclear %I \$TERM
EOF"

  if [[ ! -f "${client_env_path}" ]]; then
    run bash -c "cat > '${client_env_path}' <<EOF
BELLFORGE_KIOSK_URL=http://127.0.0.1:8000/status
EOF"
  fi

  run chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"
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
  validate_chromium
  validate_kiosk_boot
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
