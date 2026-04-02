#!/usr/bin/env bash
# scripts/bootstrap.sh — One-command BellForge installer for a fresh Raspberry Pi.
#
# Usage (run as root or with sudo):
#   curl -sSL https://raw.githubusercontent.com/YOUR_ORG/BellForge/main/scripts/bootstrap.sh | sudo bash
#
# Or after cloning the repo:
#   sudo bash scripts/bootstrap.sh
#
# Environment overrides (set before running):
#   BELLFORGE_SERVER_URL  — URL of the BellForge backend  (default: http://bellforge-server.local:8000)
#   BELLFORGE_DEVICE_ID   — Unique ID for this Pi          (default: pi-$(hostname))
#   BELLFORGE_BRANCH      — Git branch to install from     (default: main)
#
# What this script does:
#   1. Installs system dependencies (Python 3.11, Chromium, git, etc.)
#   2. Creates the bellforge system user.
#   3. Clones (or updates) the BellForge repo into /opt/bellforge.
#   4. Creates a Python virtualenv and installs backend/updater dependencies.
#   5. Writes /opt/bellforge/config/settings.json with overrides.
#   6. Installs and enables backend, updater, and kiosk client services.
#   7. Starts services and reboots.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (can be overridden via environment variables)
# ---------------------------------------------------------------------------
SERVER_URL="${BELLFORGE_SERVER_URL:-http://bellforge-server.local:8000}"
DEVICE_ID="${BELLFORGE_DEVICE_ID:-pi-$(hostname)}"
BRANCH="${BELLFORGE_BRANCH:-main}"
REPO_URL="${BELLFORGE_REPO_URL:-https://github.com/YOUR_ORG/BellForge.git}"
UPDATE_BASE_URL="${BELLFORGE_UPDATE_BASE_URL:-https://raw.githubusercontent.com/ronaldarroyowatson/BellForge/${BRANCH}}"
INSTALL_DIR="/opt/bellforge"
STAGING_DIR="/opt/bellforge/.staging"
LOG_FILE="/var/log/bellforge-updater.log"
VENV_DIR="${INSTALL_DIR}/.venv"
SERVICE_USER="bellforge"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo -e "\033[0;34m[BellForge]\033[0m $*"; }
ok()   { echo -e "\033[0;32m[  OK  ]\033[0m $*"; }
fail() { echo -e "\033[0;31m[ FAIL ]\033[0m $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || fail "This script must be run as root (use sudo)."
}

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
install_packages() {
  log "Updating package lists and installing dependencies…"
  local chromium_pkg="chromium-browser"
  if apt-cache policy chromium-browser 2>/dev/null | grep -q "Candidate: (none)"; then
    chromium_pkg="chromium"
  fi

  apt-get update -qq
  apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip \
    git \
    "${chromium_pkg}" \
    xorg openbox \
    unclutter \
    curl \
    jq
  ok "System packages installed."
}

# ---------------------------------------------------------------------------
# 2. System user
# ---------------------------------------------------------------------------
create_user() {
  if id "$SERVICE_USER" &>/dev/null; then
    log "User '$SERVICE_USER' already exists."
  else
    log "Creating system user '$SERVICE_USER'…"
    useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
    # Allow the bellforge user to run reboot/systemctl without a password
    echo "${SERVICE_USER} ALL=(ALL) NOPASSWD: /sbin/reboot, /bin/systemctl" \
      >> /etc/sudoers.d/bellforge
    chmod 440 /etc/sudoers.d/bellforge
    ok "User '$SERVICE_USER' created."
  fi
}

# ---------------------------------------------------------------------------
# 3. Clone or update the repository
# ---------------------------------------------------------------------------
clone_or_update() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Repository found at ${INSTALL_DIR} — pulling latest ${BRANCH}…"
    sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" fetch origin
    sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" checkout "$BRANCH"
    sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}"
  else
    log "Cloning BellForge (${BRANCH}) into ${INSTALL_DIR}…"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
  fi
  ok "Repository ready at ${INSTALL_DIR}."
}

# ---------------------------------------------------------------------------
# 4. Python virtualenv
# ---------------------------------------------------------------------------
setup_venv() {
  log "Setting up Python virtual environment…"
  python3.11 -m venv "$VENV_DIR"
  "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
  "${VENV_DIR}/bin/pip" install --quiet -r "${INSTALL_DIR}/backend/requirements.txt"
  "${VENV_DIR}/bin/pip" install --quiet -r "${INSTALL_DIR}/updater/requirements.txt"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "$VENV_DIR"
  ok "Virtual environment ready."
}

# ---------------------------------------------------------------------------
# 5. Write settings.json and client.env
# ---------------------------------------------------------------------------
write_settings() {
  local settings_path="${INSTALL_DIR}/config/settings.json"
  local client_env_path="${INSTALL_DIR}/config/client.env"
  log "Writing settings.json for device '${DEVICE_ID}'…"
  mkdir -p "${INSTALL_DIR}/config"

  cat > "$settings_path" <<EOF
{
  "update_base_url": "${UPDATE_BASE_URL}",
  "poll_interval_seconds": 300,
  "trigger_port": 8765,
  "install_dir": "${INSTALL_DIR}",
  "staging_dir": "${STAGING_DIR}",
  "log_file": "${LOG_FILE}",
  "max_retries": 3,
  "retry_delay_seconds": 20,
  "auto_reboot_after_update": true,
  "services_to_restart": ["bellforge-backend.service", "bellforge-client.service"],
  "preserve_local_paths": ["config/settings.json", "config/client.env"],
  "device_id": "${DEVICE_ID}"
}
EOF

  chown "${SERVICE_USER}:${SERVICE_USER}" "$settings_path"

  cat > "$client_env_path" <<EOF
BELLFORGE_KIOSK_URL=http://127.0.0.1:8000/client/index.html
BELLFORGE_DISPLAY_SCALE=0.96
BELLFORGE_STATUS_ROTATE_SECONDS=8
BELLFORGE_X_WAIT_SECONDS=45
EOF

  chown "${SERVICE_USER}:${SERVICE_USER}" "$client_env_path"
  ok "settings.json written."
}

# ---------------------------------------------------------------------------
# 6. Log directory
# ---------------------------------------------------------------------------
setup_log_dir() {
  mkdir -p "$LOG_DIR"
  chown "${SERVICE_USER}:${SERVICE_USER}" "$LOG_DIR"
}

# ---------------------------------------------------------------------------
# 7. systemd services
# ---------------------------------------------------------------------------
install_services() {
  log "Installing systemd services…"
  cp "${INSTALL_DIR}/scripts/bellforge-backend.service" /etc/systemd/system/
  cp "${INSTALL_DIR}/scripts/bellforge-updater.service" /etc/systemd/system/
  cp "${INSTALL_DIR}/scripts/bellforge-client.service"  /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable bellforge-backend.service bellforge-updater.service bellforge-client.service
  ok "Services installed and enabled."
}

# ---------------------------------------------------------------------------
# 8. Autostart Openbox (lightweight WM for kiosk)
# ---------------------------------------------------------------------------
configure_autostart() {
  local autostart_dir="/home/${SERVICE_USER}/.config/openbox"
  mkdir -p "$autostart_dir"
  cat > "${autostart_dir}/autostart" <<'EOF'
# Disable screen saver / power management
xset s off
xset -dpms
xset s noblank

# Hide cursor after 5 seconds of inactivity
unclutter -idle 5 -root &

# Chromium kiosk launch is managed by bellforge-client.service
EOF
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "/home/${SERVICE_USER}/.config"
  ok "Openbox autostart configured."
}

# ---------------------------------------------------------------------------
# 9. Enable autologin for the bellforge user (Raspbian)
# ---------------------------------------------------------------------------
configure_autologin() {
  log "Configuring autologin for '${SERVICE_USER}'…"
  mkdir -p /etc/systemd/system/getty@tty1.service.d
  cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${SERVICE_USER} --noclear %I \$TERM
EOF
  # Also configure startx on login
  local bashprofile="/home/${SERVICE_USER}/.bash_profile"
  if ! grep -q "startx" "$bashprofile" 2>/dev/null; then
    echo '[[ -z $DISPLAY && $XDG_VTNR -eq 1 ]] && exec startx -- -nocursor' >> "$bashprofile"
    chown "${SERVICE_USER}:${SERVICE_USER}" "$bashprofile"
  fi
  ok "Autologin configured."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  require_root

  echo ""
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║    BellForge Bootstrap Installer     ║"
  echo "  ╚══════════════════════════════════════╝"
  echo "  Server : ${SERVER_URL}"
  echo "  Device : ${DEVICE_ID}"
  echo "  Branch : ${BRANCH}"
  echo ""

  install_packages
  create_user
  clone_or_update
  setup_venv
  write_settings
  setup_log_dir
  install_services
  configure_autostart
  configure_autologin

  echo ""
  ok "Bootstrap complete! Rebooting in 5 seconds…"
  sleep 5
  reboot
}

main "$@"
