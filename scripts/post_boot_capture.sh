#!/usr/bin/env bash
set -euo pipefail

# Immediate Post-Boot Display Capture Script
# Run this right after Pi boot to capture state while display corruption is still visible
# Usage: ssh pi@<ip> /opt/bellforge/scripts/post_boot_capture.sh

CAPTURE_DIR="${CAPTURE_DIR:-/tmp/bellforge-boot-capture}"
mkdir -p "$CAPTURE_DIR"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" | tee -a "$CAPTURE_DIR/capture.log"
}

log "========== IMMEDIATE POST-BOOT CAPTURE =========="
log "Uptime: $(cat /proc/uptime | awk '{print $1}') seconds"

# Capture display diagnostics
log "Capturing display pipeline diagnostics..."
curl -s http://127.0.0.1:8000/api/display/pipeline > "$CAPTURE_DIR/display_pipeline.json" 2>/dev/null || log "Backend not yet available"

# Capture GPU diagnostics
log "Running GPU diagnostics script..."
python3 /opt/bellforge/scripts/gpu_diagnostics.py > "$CAPTURE_DIR/gpu_diagnostics.json" 2>&1 || log "GPU diagnostics failed"

# Capture kernel logs
log "Capturing kernel logs..."
dmesg > "$CAPTURE_DIR/dmesg.log" 2>&1 || true

# Capture system journal
log "Capturing systemd journal..."
journalctl -b --no-pager > "$CAPTURE_DIR/journal.log" 2>&1 || true

# Capture display state via xdpyinfo
log "Capturing X display state..."
DISPLAY=:0 xdpyinfo > "$CAPTURE_DIR/xdpyinfo.txt" 2>&1 || log "X not available yet"

# Capture xrandr
log "Capturing xrandr state..."
DISPLAY=:0 xrandr > "$CAPTURE_DIR/xrandr.txt" 2>&1 || log "xrandr not available yet"

# Capture service status
log "Capturing service status..."
for service in lightdm bellforge-backend bellforge-client; do
  systemctl status "$service" > "$CAPTURE_DIR/status_$service.txt" 2>&1 || true
done

# Capture process list
log "Capturing process list..."
ps auxf > "$CAPTURE_DIR/processes.txt" 2>&1 || true

# Capture memory info
log "Capturing memory info..."
cat /proc/meminfo > "$CAPTURE_DIR/meminfo.txt" 2>&1 || true

# Capture thermal info
log "Capturing thermal info..."
for i in /sys/class/thermal/thermal_zone*/temp; do
  [[ -f "$i" ]] && echo "$(dirname $i): $(cat $i) mK" >> "$CAPTURE_DIR/thermal.txt" 2>&1 || true
done

# Capture lspci
log "Capturing lspci..."
lspci -v > "$CAPTURE_DIR/lspci.txt" 2>&1 || true

# Capture fbset
log "Capturing framebuffer info..."
fbset -i > "$CAPTURE_DIR/fbset.txt" 2>&1 || true

# Capture screen using fbgrab if available
log "Attempting to capture framebuffer to image..."
if command -v fbgrab >/dev/null 2>&1; then
  DISPLAY=:0 fbgrab -c -d /dev/fb0 "$CAPTURE_DIR/framebuffer.png" 2>&1 || log "fbgrab failed"
elif command -v gnome-screenshot >/dev/null 2>&1; then
  DISPLAY=:0 gnome-screenshot -f "$CAPTURE_DIR/screenshot.png" 2>&1 || log "gnome-screenshot failed"
fi

# Capture detailed Chromium process info
log "Capturing Chromium details..."
ps aus | grep -i chromium > "$CAPTURE_DIR/chromium_processes.txt" 2>&1 || true

log "========== CAPTURE COMPLETE =========="
log "Files saved to: $CAPTURE_DIR"
log "Listing captured files:"
ls -lah "$CAPTURE_DIR"

# Show last lines of key files
log "========== KEY INFORMATION =========="
if [[ -f "$CAPTURE_DIR/display_pipeline.json" ]]; then
  log "Display pipeline health:"
  grep -o '"health":"[^"]*"' "$CAPTURE_DIR/display_pipeline.json" || true
fi

if [[ -f "$CAPTURE_DIR/dmesg.log" ]]; then
  log "Recent GPU/DRM errors in dmesg:"
  grep -i "gpu\|drm.*error\|hdmi" "$CAPTURE_DIR/dmesg.log" | tail -5 || true
fi

log "Capture output available for analysis at: $CAPTURE_DIR"
