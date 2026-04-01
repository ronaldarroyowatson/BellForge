#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

# Load site-local configuration if present (not inherited when launched from Openbox autostart).
_client_env="${BELLFORGE_CONFIG_DIR:-/opt/bellforge/config}/client.env"
# shellcheck disable=SC1090
[[ -f "${_client_env}" ]] && . "${_client_env}"
unset _client_env

KIOSK_URL="${BELLFORGE_KIOSK_URL:-http://127.0.0.1:8000/status}"
CEC_POWER_ON="${BELLFORGE_CEC_POWER_ON:-1}"
HDMI_WAIT_SECONDS="${BELLFORGE_HDMI_WAIT_SECONDS:-45}"

find_browser() {
  if [[ -n "${BELLFORGE_BROWSER_BIN:-}" ]]; then
    echo "${BELLFORGE_BROWSER_BIN}"
    return
  fi

  command -v chromium-browser >/dev/null 2>&1 && { echo "chromium-browser"; return; }
  command -v chromium >/dev/null 2>&1 && { echo "chromium"; return; }
  return 1
}

send_cec_power_on() {
  [[ "${CEC_POWER_ON}" == "1" ]] || return 0

  if ! command -v cec-client >/dev/null 2>&1; then
    log "cec-client not found; skipping CEC power-on"
    return 0
  fi

  # CEC command sequence:
  #   on 0: turn on TV
  #   as: set this device as active source
  { printf 'on 0\nas\nquit\n' | cec-client -s -d 1 >/dev/null 2>&1; } || true
  log "Sent HDMI-CEC power-on/active-source commands"
}

wait_for_hdmi() {
  local elapsed=0

  while (( elapsed < HDMI_WAIT_SECONDS )); do
    if grep -q "connected" /sys/class/drm/card*-HDMI-A-*/status 2>/dev/null; then
      log "Detected connected HDMI output"
      return 0
    fi
    sleep 1
    ((elapsed += 1))
  done

  log "No HDMI connection detected after ${HDMI_WAIT_SECONDS}s; continuing anyway"
  return 0
}

main() {
  local browser

  browser="$(find_browser)" || {
    log "No Chromium binary found"
    exit 1
  }

  send_cec_power_on
  wait_for_hdmi

  exec "${browser}" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-background-networking \
    --disable-translate \
    --app="${KIOSK_URL}"
}

main "$@"
