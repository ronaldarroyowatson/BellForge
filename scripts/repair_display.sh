#!/usr/bin/env bash
set -euo pipefail

# BellForge Display Repair Script
# Quick remediation for display corruption issues on Raspberry Pi
# Can be run while display is showing corruption

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" | tee -a /tmp/display_repair.log
}

log_ok() {
  echo "✓ $*"
}

log_err() {
  echo "✗ $*" >&2
}

assert_root() {
  if [[ $EUID -ne 0 ]]; then
    log_err "This script must be run as root"
    exit 1
  fi
}

repair_display() {
  local repair_step="$1"
  
  case "$repair_step" in
    "quick")
      # Quick in-place display correction (no reboot)
      log "Running QUICK repair (no reboot)..."
      
      log "  1/4: Clearing framebuffer..."
      if [[ -w /dev/fb0 ]]; then
        dd if=/dev/zero of=/dev/fb0 bs=1M count=1 2>/dev/null && log_ok "Framebuffer cleared" || log_err "Framebuffer clear failed"
      fi
      
      log "  2/4: Restarting display manager..."
      systemctl restart lightdm.service 2>&1 | grep -i error && log_err "LightDM restart had errors" || log_ok "LightDM restarted"
      
      log "  3/4: Waiting for X server..."
      local x_wait=0
      while [[ ! -S /tmp/.X11-unix/X0 && $x_wait -lt 20 ]]; do
        sleep 1
        ((x_wait++))
      done
      
      if [[ -S /tmp/.X11-unix/X0 ]]; then
        log_ok "X server ready"
      else
        log_err "X server did not start"
      fi
      
      log "  4/4: Restarting Chromium..."
      systemctl restart bellforge-client.service && log_ok "Client restarted" || log_err "Client restart failed"
      
      log "Quick repair complete. Monitor display for 30 seconds..."
      sleep 30
      
      # Check status
      if systemctl is-active bellforge-client.service >/dev/null 2>&1; then
        log_ok "Client service is active"
      else
        log_err "Client service failed to start"
      fi
      ;;
      
    "medium")
      # Medium repair with some GPU initialization (no reboot)
      log "Running MEDIUM repair (GPU reset, no reboot)..."
      
      log "  1/5: Stopping Chromium..."
      systemctl stop bellforge-client.service 2>&1 || log "Client already stopped"
      sleep 2
      
      log "  2/5: Clearing framebuffer..."
      dd if=/dev/zero of=/dev/fb0 bs=1M count=1 2>/dev/null || true
      
      log "  3/5: Flushing cache..."
      sync
      sleep 1
      
      log "  4/5: Setting display mode..."
      DISPLAY=:0 xrandr --output HDMI-1 --mode 1920x1080 --rate 60 2>/dev/null || log_err "xrandr failed"
      
      log "  5/5: Restarting Chromium..."
      systemctl start bellforge-client.service && log_ok "Client started" || log_err "Client failed to start"
      
      log "Medium repair complete. Wait 15 seconds for browser to load..."
      sleep 15
      ;;
      
    "cold-reboot")
      # Full cold reboot for complete GPU reset
      log "Running COLD REBOOT repair (full GPU reset)..."
      echo "Initiating cold reboot in 5 seconds. Pi will restart completely." >&2
      sleep 5
      
      log "System reboot initiated"
      /sbin/reboot
      ;;
      
    "deep")
      # Deep repair: try kernel module reload
      log "Running DEEP repair (kernel module reload)..."
      
      log "  1/3: Stopping services..."
      systemctl stop bellforge-client.service 2>&1 || true
      systemctl stop bellforge-backend.service 2>&1 || true
      sleep 2
      
      log "  2/3: Reloading GPU drivers..."
      # Attempt to reload vc4/v3d drivers  
      for module in v3d vc4-kms-dsi vc4; do
        if grep -q "^$module " /proc/modules 2>/dev/null; then
          log "  - Unloading $module..."
          modprobe -r "$module" 2>&1 || log "  - (failed, may be in use)"
          sleep 1
          log "  - Loading $module..."
          modprobe "$module" 2>&1 || log "  - (failed)"
        fi
      done
      
      log "  3/3: Restarting services..."
      systemctl start bellforge-backend.service
      sleep 2
      systemctl start bellforge-client.service
      
      log "Deep repair complete. Wait 30 seconds for recovery..."
      sleep 30
      ;;
      
    *)
      log_err "Unknown repair step: $repair_step"
      return 1
      ;;
  esac
}

print_menu() {
  cat <<EOF

╔════════════════════════════════════════════════════════════════╗
║          BellForge Display Repair ($(date +%H:%M:%S))            ║
╚════════════════════════════════════════════════════════════════╝

Choose repair level:

  1) QUICK   - Clear framebuffer, restart services (30 sec)
  2) MEDIUM  - GPU reset, display mode set (45 sec)
  3) DEEP    - Reload GPU drivers (60 sec)
  4) COLD    - Full system reboot (2 min)
  5) DIAG    - Run diagnostics without repair
  6) EXIT

Select option [1-6]: 
EOF
}

main() {
  assert_root
  
  log "=========== BellForge Display Repair ==========="
  log "Display may show corruption during repair process"
  log "This is normal - do not interrupt"
  echo ""
  
  # If called with argument, use that as repair step
  if [[ $# -gt 0 ]]; then
    repair_level="$1"
  else
    # Interactive menu
    while true; do
      print_menu
      read -r repair_level
      
      case "$repair_level" in
        1) repair_step="quick"; break ;;
        2) repair_step="medium"; break ;;
        3) repair_step="deep"; break ;;
        4) repair_step="cold-reboot"; break ;;
        5) 
          echo "Running diagnostics..."
          python3 /opt/bellforge/scripts/gpu_diagnostics.py | jq .
          exit 0
          ;;
        6) exit 0 ;;
        *) echo "Invalid option"; continue ;;
      esac
    done
  fi
  
  case "$repair_level" in
    1) repair_display "quick" ;;
    2) repair_display "medium" ;;
    3) repair_display "deep" ;;
    4) repair_display "cold-reboot" ;;
    "quick") repair_display "quick" ;;
    "medium") repair_display "medium" ;;
    "deep") repair_display "deep" ;;
    "cold-reboot") repair_display "cold-reboot" ;;
    *)
      log_err "Invalid repair level: $repair_level"
      exit 1
      ;;
  esac
  
  log "=========== Repair Complete ==========="
  log "Check display for normal rendering"
  log "Log saved to: /tmp/display_repair.log"
  
  # Final status check
  echo ""
  echo "Final Status:"
  systemctl is-active bellforge-client.service && echo "  ✓ Chromium is running" || echo "  ✗ Chromium is NOT running"
  systemctl is-active lightdm.service && echo "  ✓ LightDM is running" || echo "  ✗ LightDM is NOT running"
  
  if curl -fs http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "  ✓ Backend health OK"
  else
    echo "  ✗ Backend not responding"
  fi
}

main "$@"
