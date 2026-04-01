#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

log_debug() {
  [[ "${DEBUG_KIOSK:-0}" == "1" ]] && log "DEBUG: $*"
}

log_error() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ERROR: $*" >&2
}

# Load site-local configuration if present (not inherited when launched from Openbox autostart).
_client_env="${BELLFORGE_CONFIG_DIR:-/opt/bellforge/config}/client.env"
# shellcheck disable=SC1090
[[ -f "${_client_env}" ]] && . "${_client_env}"
unset _client_env

KIOSK_URL="${BELLFORGE_KIOSK_URL:-http://127.0.0.1:8000/client/index.html}"
CEC_POWER_ON="${BELLFORGE_CEC_POWER_ON:-1}"
HDMI_WAIT_SECONDS="${BELLFORGE_HDMI_WAIT_SECONDS:-45}"
X_WAIT_SECONDS="${BELLFORGE_X_WAIT_SECONDS:-45}"
GPU_INIT_DELAY="${BELLFORGE_GPU_INIT_DELAY:-8}"
DISPLAY="${DISPLAY:-:0}"
export DISPLAY

# Diagnostic flags
DIAG_GPU_MODE="${BELLFORGE_DIAG_GPU_MODE:-0}"
DIAG_BOOT="${BELLFORGE_DIAG_BOOT:-0}"

diagnose_gpu() {
  log "========== GPU DIAGNOSTICS =========="
  
  # Check GPU device
  if [[ -d "/sys/bus/pci/devices" ]]; then
    log_debug "PCI devices detected"
    if lspci 2>/dev/null | grep -i "vga\|3d\|display" | head -3; then
      log "GPU device found in PCI bus"
    fi
  fi
  
  # Check DRM devices
  if [[ -d "/sys/class/drm" ]]; then
    log "DRM devices:"
    for device in /sys/class/drm/card*-*/; do
      [[ -d "$device" ]] && log "  - $(basename "$device")"
    done
  fi
  
  # Check framebuffer
  if [[ -e "/dev/fb0" ]]; then
    log "Framebuffer /dev/fb0 present"
    if command -v fbset &>/dev/null; then
      fbset -i 2>&1 | head -5 | sed 's/^/  /'
    fi
  fi
  
  # Check memory pressure
  if [[ -f "/proc/meminfo" ]]; then
    mem_avail=$(grep "MemAvailable" /proc/meminfo | awk '{print $2}')
    mem_total=$(grep "MemTotal" /proc/meminfo | awk '{print $2}')
    if [[ -n "$mem_avail" && -n "$mem_total" ]]; then
      mem_pressure=$((100 - (mem_avail * 100 / mem_total)))
      log "Memory pressure: ${mem_pressure}%"
    fi
  fi
  
  # Check thermal status
  if [[ -f "/sys/class/thermal/thermal_zone0/temp" ]]; then
    temp_mk=$(cat /sys/class/thermal/thermal_zone0/temp)
    temp_c=$((temp_mk / 1000))
    log "GPU temperature: ${temp_c}°C"
    if (( temp_c > 80 )); then
      log_error "GPU THERMAL THROTTLE RISK"
    fi
  fi
  
  log "====================================="
}

diagnose_boot() {
  log "========== BOOT DIAGNOSTICS =========="
  
  # Uptime
  uptime_sec=$(cut -d' ' -f1 /proc/uptime | cut -d'.' -f1)
  uptime_min=$((uptime_sec / 60))
  log "System uptime: ${uptime_min}m"
  
  # Disk space
  if df / &>/dev/null; then
    df_output=$(df / | tail -1)
    used_pct=$(echo "$df_output" | awk '{print $5}' | sed 's/%//')
    log "Root filesystem: ${used_pct}% used"
    if (( used_pct > 90 )); then
      log_error "Low disk space"
    fi
  fi
  
  # systemd journal errors
  if command -v journalctl &>/dev/null; then
    error_count=$(journalctl -b --no-pager -p err..crit 2>/dev/null | wc -l || echo 0)
    log "Journal errors this boot: $error_count"
  fi
  
  log "====================================="
}

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
    log_debug "cec-client not found; skipping CEC power-on"
    return 0
  fi

  # CEC command sequence:
  #   on 0: turn on TV
  #   as: set this device as active source
  log "Sending HDMI-CEC commands..."
  if command -v timeout >/dev/null 2>&1; then
    { timeout 4s sh -c "printf 'on 0\\nas\\nquit\\n' | cec-client -s -d 1 >/dev/null 2>&1"; } || true
  else
    { printf 'on 0\nas\nquit\n' | cec-client -s -d 1 >/dev/null 2>&1; } || true
  fi
  log "CEC commands sent"
}

wait_for_hdmi() {
  local elapsed=0
  local found=0

  log "Waiting up to ${HDMI_WAIT_SECONDS}s for connected HDMI output..."
  
  while (( elapsed < HDMI_WAIT_SECONDS )); do
    if grep -q "connected" /sys/class/drm/card*-HDMI-A-*/status 2>/dev/null; then
      log "Detected connected HDMI output"
      found=1
      break
    fi
    
    # Check for EDID to detect connection
    if [[ -f /sys/class/drm/card0-HDMI-A-1/edid ]] && grep -q . /sys/class/drm/card0-HDMI-A-1/edid 2>/dev/null; then
      log "EDID detected on HDMI-A-1"
      found=1
      break
    fi
    
    sleep 1
    ((elapsed += 1))
    (( elapsed % 5 == 0 )) && log_debug "Still waiting for HDMI... (${elapsed}s)"
  done

  if (( found == 0 )); then
    log_error "No HDMI connection detected after ${HDMI_WAIT_SECONDS}s"
    # Don't fail - fall through and try anyway
  fi
  
  return 0
}

wait_for_x() {
  local elapsed=0
  local ready=0

  log "Waiting up to ${X_WAIT_SECONDS}s for X display server..."
  
  while (( elapsed < X_WAIT_SECONDS )); do
    # Check X socket
    if [[ -S /tmp/.X11-unix/X0 ]]; then
      log_debug "X display socket found"
      ready=1
    fi
    
    # Verify X is actually responsive
    if [[ $ready -eq 1 ]] && command -v xdpyinfo >/dev/null 2>&1; then
      if DISPLAY="${DISPLAY}" xdpyinfo >/dev/null 2>&1; then
        log "X display is ready and responsive"
        return 0
      fi
    fi
    
    sleep 1
    ((elapsed += 1))
    (( elapsed % 5 == 0 )) && log_debug "X not ready... (${elapsed}s)"
  done

  log_error "X display not ready after ${X_WAIT_SECONDS}s"
  return 1
}

init_gpu() {
  log "Initializing GPU and bringing up display..."
  
  # Give GPU time to initialize after X starts
  log "Waiting ${GPU_INIT_DELAY}s for GPU initialization..."
  sleep "$GPU_INIT_DELAY"
  
  # Clear framebuffer to prevent corruption artifacts
  log "Clearing framebuffer..."
  if command -v fbset >/dev/null 2>&1; then
    fbset -c 16 2>/dev/null || true
  fi
  if [[ -w /dev/fb0 ]]; then
    dd if=/dev/zero of=/dev/fb0 bs=1M count=1 2>/dev/null || true
  fi
  
  # Set display mode if available
  if command -v xrandr >/dev/null 2>&1; then
    log "Detecting display modes..."
    xrandr_output=$(xrandr 2>/dev/null || echo "")
    if echo "$xrandr_output" | grep -q "connected"; then
      log "Available displays: $(echo "$xrandr_output" | grep connected | awk '{print $1}' | tr '\n' ', ')"
      
      # Try to set a safe mode
      connected=$(echo "$xrandr_output" | grep connected | head -1 | awk '{print $1}')
      if [[ -n "$connected" ]]; then
        log "Attempting to set display mode on $connected..."
        xrandr --output "$connected" --mode 1920x1080 --rate 60 2>/dev/null || true
      fi
    fi
  fi
  
  # Flush GPU caches and sync
  log "GPU sync..."
  sync 2>/dev/null || true
}

validate_network() {
  log "Validating backend connectivity..."
  
  # Try to reach backend health endpoint
  if command -v timeout >/dev/null 2>&1; then
    if timeout 3s curl -fs http://127.0.0.1:8000/health >/dev/null 2>&1; then
      log "Backend health check OK"
      return 0
    else
      log_error "Backend not responding to health check"
      return 1
    fi
  fi
  return 0
}

main() {
  local browser

  log "=========== BellForge Kiosk Starting ==========="
  
  # Diagnostic mode
  [[ "${DIAG_GPU_MODE}" == "1" ]] && diagnose_gpu
  [[ "${DIAG_BOOT}" == "1" ]] && diagnose_boot

  browser="$(find_browser)" || {
    log_error "No Chromium binary found"
    exit 1
  }
  log "Using browser: $browser"

  send_cec_power_on
  wait_for_hdmi
  
  if ! wait_for_x; then
    log_error "X server startup failed; exiting for systemd restart"
    exit 1
  fi
  
  init_gpu
  validate_network || log_error "Backend unreachable; will retry via client"
  
  log "Launching Chromium at $KIOSK_URL"
  log "=============== LAUNCHING BROWSER ==============="
  
  exec "${browser}" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-background-networking \
    --disable-translate \
    --disable-sync \
    --disable-plugins-power-saver \
    --disable-component-update \
    --no-sandbox \
    --single-process=false \
    --app="${KIOSK_URL}"
}

main "$@"
