#!/usr/bin/env bash
set -euo pipefail

# Deploy Display Pipeline Enhancements to Raspberry Pi
# Usage: ./deploy_display_fixes.sh <pi_ip> [<pi_user>]

PI_IP="${1:-}"
PI_USER="${2:-pi}"

if [[ -z "$PI_IP" ]]; then
  echo "Usage: ./deploy_display_fixes.sh <pi_ip> [<pi_user>]"
  echo "Example: ./deploy_display_fixes.sh 192.168.1.100"
  exit 1
fi

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

log "========== Deploying Display Fixes to $PI_IP =========="

# Test SSH connection
if ! ssh -o ConnectTimeout=5 "$PI_USER@$PI_IP" "echo 'SSH OK'" >/dev/null 2>&1; then
  echo "✗ Cannot connect to $PI_IP as $PI_USER"
  exit 1
fi

log "✓ SSH connection verified"

# Deploy backend services
log "Deploying backend services..."
scp backend/services/display_pipeline.py "$PI_USER@$PI_IP":/opt/bellforge/backend/services/ 2>/dev/null && log "  ✓ display_pipeline.py" || log "  ✗ display_pipeline.py"
scp backend/routes/diagnostics.py "$PI_USER@$PI_IP":/opt/bellforge/backend/routes/ 2>/dev/null && log "  ✓ diagnostics.py" || log "  ✗ diagnostics.py"

# Deploy scripts
log "Deploying scripts..."
scp scripts/start_kiosk.sh "$PI_USER@$PI_IP":/opt/bellforge/scripts/ 2>/dev/null && log "  ✓ start_kiosk.sh" || log "  ✗ start_kiosk.sh"
scp scripts/gpu_diagnostics.py "$PI_USER@$PI_IP":/opt/bellforge/scripts/ 2>/dev/null && log "  ✓ gpu_diagnostics.py" || log "  ✗ gpu_diagnostics.py"
scp scripts/post_boot_capture.sh "$PI_USER@$PI_IP":/opt/bellforge/scripts/ 2>/dev/null && log "  ✓ post_boot_capture.sh" || log "  ✗ post_boot_capture.sh"
scp scripts/repair_display.sh "$PI_USER@$PI_IP":/opt/bellforge/scripts/ 2>/dev/null && log "  ✓ repair_display.sh" || log "  ✗ repair_display.sh"

# Deploy tests
log "Deploying test suites..."
scp tests/test_display_pipeline.sh "$PI_USER@$PI_IP":/opt/bellforge/tests/ 2>/dev/null && log "  ✓ test_display_pipeline.sh" || log "  ✗ test_display_pipeline.sh"
scp tests/test_display_stress.sh "$PI_USER@$PI_IP":/opt/bellforge/tests/ 2>/dev/null && log "  ✓ test_display_stress.sh" || log "  ✗ test_display_stress.sh"

# Deploy documentation
log "Deploying documentation..."
scp docs/DISPLAY_DEBUGGING_GUIDE.md "$PI_USER@$PI_IP":/opt/bellforge/docs/ 2>/dev/null && log "  ✓ DISPLAY_DEBUGGING_GUIDE.md" || log "  ✗ DISPLAY_DEBUGGING_GUIDE.md"

# Make scripts executable
log "Setting execute permissions..."
if ssh "$PI_USER@$PI_IP" "sudo chmod +x /opt/bellforge/scripts/start_kiosk.sh /opt/bellforge/scripts/gpu_diagnostics.py /opt/bellforge/scripts/post_boot_capture.sh /opt/bellforge/scripts/repair_display.sh /opt/bellforge/tests/test_display_pipeline.sh /opt/bellforge/tests/test_display_stress.sh"; then
  log "  ✓ Permissions set"
else
  log "  ✗ Permission setting failed"
  exit 1
fi

# Restart backend to load new code
log "Restarting backend service to load new diagnostics code..."
if ssh "$PI_USER@$PI_IP" "sudo systemctl restart bellforge-backend.service"; then
  log "  ✓ Backend restarted"
else
  log "  ✗ Backend restart failed"
  exit 1
fi

# Verify deployment
log "Verifying deployment..."
if ssh "$PI_USER@$PI_IP" "test -f /opt/bellforge/scripts/gpu_diagnostics.py" 2>/dev/null; then
  log "✓ Deployment verified"
else
  log "✗ Deployment verification failed"
  exit 1
fi

log "========== Deployment Complete =========="
echo ""
echo "Next steps:"
echo "  1. SSH to the Pi: ssh $PI_USER@$PI_IP"
echo "  2. Reboot to trigger display issue: sudo reboot"
echo "  3. While display is corrupted, run capture: sudo /opt/bellforge/scripts/post_boot_capture.sh"
echo "  4. Download diagnostics: scp -r $PI_USER@$PI_IP:/tmp/bellforge-boot-capture ~/bellforge-diagnostics"
echo "  5. Review captured files to identify issue"
echo "  6. Run tests: sudo /opt/bellforge/tests/test_display_pipeline.sh"
echo "  7. Try repairs: sudo /opt/bellforge/scripts/repair_display.sh"
echo ""
echo "Documentation: /opt/bellforge/docs/DISPLAY_DEBUGGING_GUIDE.md"
