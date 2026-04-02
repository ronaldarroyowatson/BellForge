#!/usr/bin/env bash
set -euo pipefail

# Comprehensive display pipeline test suite
# Tests every stage of the display rendering pipeline and checks for common failures

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

TEST_LOG_DIR="${TEST_LOG_DIR:-/tmp/bellforge-tests}"
mkdir -p "$TEST_LOG_DIR"

LOG_FILE="${TEST_LOG_DIR}/display_pipeline.log"
exec > >(tee "$LOG_FILE") 2>&1

# Test results tracking
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
WARNINGS=0

test_case() {
  local name="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $name [$TESTS_RUN]"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

pass_test() {
  local message="${1:-Test passed}"
  echo "✓ PASS: $message"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail_test() {
  local message="${1:-Test failed}"
  echo "✗ FAIL: $message"
  TESTS_FAILED=$((TESTS_FAILED + 1))
}

warn_test() {
  local message="${1:-Warning}"
  echo "⚠ WARN: $message"
  WARNINGS=$((WARNINGS + 1))
}

# ===========================================================================
# LAYER 1: HARDWARE & KERNEL
# ===========================================================================

test_hdmi_detection() {
  test_case "HDMI Cable Detection"
  
  local hdmi_found=0
  if [[ -d /sys/class/drm ]]; then
    if grep -q "connected" /sys/class/drm/card*-HDMI-A-*/status 2>/dev/null; then
      pass_test "HDMI output is connected"
      hdmi_found=1
    else
      local status=$(cat /sys/class/drm/card*-HDMI-A-*/status 2>/dev/null | head -1)
      if [[ -z "$status" ]]; then
        fail_test "HDMI status file not found"
      else
        fail_test "HDMI output status: $status (not connected)"
      fi
    fi
  else
    fail_test "DRM subsystem not available"
  fi
  
  return $([[ $hdmi_found -eq 1 ]] && echo 0 || echo 1)
}

test_drm_devices() {
  test_case "DRM Devices Available"
  
  local drm_count=0
  if [[ -d /sys/class/drm ]]; then
    drm_count=$(find /sys/class/drm -maxdepth 1 -name "card*" -type d | wc -l)
    if [[ $drm_count -gt 0 ]]; then
      pass_test "Found $drm_count DRM card device(s)"
    else
      fail_test "No DRM card devices found"
    fi
  else
    fail_test "DRM subsystem not available"
  fi
  
  return $([[ $drm_count -gt 0 ]] && echo 0 || echo 1)
}

test_framebuffer() {
  test_case "Framebuffer Device"
  
  if [[ -e /dev/fb0 ]]; then
    pass_test "/dev/fb0 framebuffer device exists"
    
    if [[ -r /dev/fb0 ]]; then
      pass_test "/dev/fb0 is readable"
    else
      warn_test "/dev/fb0 is not readable"
    fi
    
    if [[ -w /dev/fb0 ]]; then
      pass_test "/dev/fb0 is writable"
    else
      warn_test "/dev/fb0 is not writable"
    fi
  else
    fail_test "/dev/fb0 framebuffer device not found"
  fi
  
  return 0
}

test_gpu_memory() {
  test_case "GPU Memory and Thermal Status"
  
  local thermal_ok=true
  
  # Check memory pressure
  if [[ -f /proc/meminfo ]]; then
    local mem_avail=$(grep "MemAvailable" /proc/meminfo | awk '{print $2}')
    local mem_total=$(grep "MemTotal" /proc/meminfo | awk '{print $2}')
    if [[ -n "$mem_avail" && -n "$mem_total" ]]; then
      local mem_pressure=$((100 - (mem_avail * 100 / mem_total)))
      echo "Memory pressure: ${mem_pressure}%"
      
      if [[ $mem_pressure -lt 75 ]]; then
        pass_test "Memory pressure acceptable (<75%)"
      elif [[ $mem_pressure -lt 90 ]]; then
        warn_test "Memory pressure elevated (${mem_pressure}%)"
      else
        fail_test "Memory pressure critical (${mem_pressure}%)"
        thermal_ok=false
      fi
    fi
  fi
  
  # Check thermal
  if [[ -f /sys/class/thermal/thermal_zone0/temp ]]; then
    local temp_mk=$(cat /sys/class/thermal/thermal_zone0/temp)
    local temp_c=$((temp_mk / 1000))
    echo "GPU temperature: ${temp_c}°C"
    
    if [[ $temp_c -lt 70 ]]; then
      pass_test "GPU temperature normal (${temp_c}°C)"
    elif [[ $temp_c -lt 80 ]]; then
      warn_test "GPU temperature elevated (${temp_c}°C)"
    else
      fail_test "GPU temperature critical or throttling (${temp_c}°C)"
      thermal_ok=false
    fi
  fi
  
  return $($thermal_ok && echo 0 || echo 1)
}

# ===========================================================================
# LAYER 2: DISPLAY MANAGER & X SERVER
# ===========================================================================

test_lightdm_service() {
  test_case "LightDM Display Manager Service"
  
  local active=$(systemctl is-active lightdm.service 2>/dev/null || echo "inactive")
  local enabled=$(systemctl is-enabled lightdm.service 2>/dev/null || echo "disabled")
  
  echo "Service status: $active"
  echo "Service enabled: $enabled"
  
  if [[ "$active" == "active" ]]; then
    pass_test "lightdm.service is active"
  else
    fail_test "lightdm.service is not active (status: $active)"
  fi
  
  if [[ "$enabled" == "enabled" ]]; then
    pass_test "lightdm.service is enabled"
  else
    warn_test "lightdm.service is not enabled"
  fi
  
  return 0
}

test_x_server_socket() {
  test_case "X Server Socket Availability"
  
  if [[ -S /tmp/.X11-unix/X0 ]]; then
    pass_test "X display socket /tmp/.X11-unix/X0 exists"
  else
    fail_test "X display socket not found"
    return 1
  fi
  
  return 0
}

test_x_display_responsive() {
  test_case "X Display Server Responsiveness"
  
  if ! command -v xdpyinfo >/dev/null 2>&1; then
    warn_test "xdpyinfo not available; cannot test X responsiveness"
    return 0
  fi
  
  if DISPLAY=:0 timeout 3s xdpyinfo >/dev/null 2>&1; then
    pass_test "X server is responsive (xdpyinfo succeeded)"
  else
    fail_test "X server not responsive (xdpyinfo failed)"
    return 1
  fi
  
  return 0
}

test_xrandr_display_modes() {
  test_case "X Display Modes and Resolution"
  
  if ! command -v xrandr >/dev/null 2>&1; then
    warn_test "xrandr not available; cannot detect display modes"
    return 0
  fi
  
  local xrandr_output
  if xrandr_output=$(DISPLAY=:0 xrandr 2>&1); then
    if echo "$xrandr_output" | grep -q "connected"; then
      local connected=$(echo "$xrandr_output" | grep "connected" | head -1 | awk '{print $1}')
      local resolution=$(echo "$xrandr_output" | grep "connected" | head -1 | grep -o "[0-9]\+x[0-9]\+" | head -1)
      
      if [[ -n "$resolution" ]]; then
        pass_test "Display $connected is connected with resolution $resolution"
      else
        warn_test "Display $connected is connected but resolution not detected"
      fi
    else
      fail_test "No connected displays found in xrandr output"
      return 1
    fi
  else
    fail_test "xrandr command failed"
    return 1
  fi
  
  return 0
}

# ===========================================================================
# LAYER 3: CHROMIUM BROWSER PROCESS
# ===========================================================================

test_chromium_available() {
  test_case "Chromium Browser Binary"
  
  local browser_cmd=""
  if command -v chromium-browser >/dev/null 2>&1; then
    browser_cmd="chromium-browser"
  elif command -v chromium >/dev/null 2>&1; then
    browser_cmd="chromium"
  fi
  
  if [[ -n "$browser_cmd" ]]; then
    pass_test "Chromium binary found: $browser_cmd"
    
    local version=$(DISPLAY=:0 timeout 3s "$browser_cmd" --version 2>&1 | head -1 || echo "unknown")
    echo "Version: $version"
  else
    fail_test "Chromium binary not found"
    return 1
  fi
  
  return 0
}

test_bellforge_client_service() {
  test_case "BellForge Client Service"
  
  local active=$(systemctl is-active bellforge-client.service 2>/dev/null || echo "inactive")
  local enabled=$(systemctl is-enabled bellforge-client.service 2>/dev/null || echo "disabled")
  
  echo "Service status: $active"
  echo "Service enabled: $enabled"
  
  if [[ "$active" == "active" ]]; then
    pass_test "bellforge-client.service is active"
  else
    fail_test "bellforge-client.service is not active"
  fi
  
  if [[ "$enabled" == "enabled" ]]; then
    pass_test "bellforge-client.service is enabled"
  else
    warn_test "bellforge-client.service is not enabled"
  fi
  
  return 0
}

# ===========================================================================
# LAYER 4: BACKEND API & HTTP
# ===========================================================================

test_backend_service() {
  test_case "BellForge Backend Service"
  
  local active=$(systemctl is-active bellforge-backend.service 2>/dev/null || echo "inactive")
  
  if [[ "$active" == "active" ]]; then
    pass_test "bellforge-backend.service is active"
  else
    fail_test "bellforge-backend.service is not active"
    return 1
  fi
  
  return 0
}

test_backend_health() {
  test_case "Backend Health Endpoint"
  
  if command -v timeout >/dev/null 2>&1; then
    if timeout 3s curl -fs http://127.0.0.1:8000/health >/dev/null 2>&1; then
      pass_test "Backend health endpoint responds successfully"
    else
      fail_test "Backend health endpoint request failed"
      return 1
    fi
  else
    warn_test "timeout command not available; skipping health check"
  fi
  
  return 0
}

test_kiosk_page() {
  test_case "Kiosk HTML Page"
  
  if command -v timeout >/dev/null 2>&1; then
    local page_html
    if page_html=$(timeout 3s curl -s http://127.0.0.1:8000/client/index.html 2>&1); then
      if echo "$page_html" | grep -q "html\|DOCTYPE"; then
        pass_test "Kiosk page loads successfully"
        
        # Check for required elements
        if echo "$page_html" | grep -q "id=\"screen\"\|id=\"time-display\""; then
          pass_test "Kiosk page contains expected DOM elements"
        else
          warn_test "Some expected DOM elements not found"
        fi
      else
        fail_test "Kiosk page response is not valid HTML"
        return 1
      fi
    else
      fail_test "Failed to fetch kiosk page"
      return 1
    fi
  else
    warn_test "timeout/curl not available; skipping page check"
  fi
  
  return 0
}

test_schedule_api() {
  test_case "Schedule API Endpoint"
  
  if command -v timeout >/dev/null 2>&1; then
    local schedule_json
    if schedule_json=$(timeout 3s curl -s http://127.0.0.1:8000/api/schedule 2>&1); then
      if echo "$schedule_json" | grep -q "periods\|school_name"; then
        pass_test "Schedule API returns valid schedule data"
      else
        warn_test "Schedule API response lacks expected fields"
      fi
    else
      fail_test "Schedule API request failed"
      return 1
    fi
  else
    warn_test "timeout/curl not available; skipping schedule check"
  fi
  
  return 0
}

test_display_diagnostics_api() {
  test_case "Display Diagnostics API"
  
  if command -v timeout >/dev/null 2>&1; then
    local diag_json
    if diag_json=$(timeout 5s curl -s http://127.0.0.1:8000/api/display/pipeline 2>&1); then
      if echo "$diag_json" | grep -q "health\|services\|hdmi_outputs"; then
        pass_test "Display diagnostics API returns valid data"
        
        # Check health status
        health=$(echo "$diag_json" | grep -o '"health":"[^"]*"' | cut -d'"' -f4)
        echo "System health: $health"
        
        if [[ "$health" == "ok" ]]; then
          pass_test "Display pipeline health is OK"
        elif [[ "$health" == "warn" ]]; then
          warn_test "Display pipeline health is WARN"
        else
          fail_test "Display pipeline health is ERROR"
        fi
      else
        fail_test "Display diagnostics response lacks expected fields"
        return 1
      fi
    else
      fail_test "Display diagnostics API request failed"
      return 1
    fi
  else
    warn_test "timeout/curl not available; skipping diagnostics check"
  fi
  
  return 0
}

# ===========================================================================
# LAYER 5: APPLICATION LOGIC
# ===========================================================================

test_javascript_rendering() {
  test_case "JavaScript and DOM Rendering"
  
  # This requires actually running the browser, so we'll do a lighter check
  if command -v timeout >/dev/null 2>&1; then
    local page_html
    if page_html=$(timeout 3s curl -s http://127.0.0.1:8000/client/index.html 2>&1); then
      if echo "$page_html" | grep -q "main.js\|<script"; then
        pass_test "Kiosk page includes JavaScript"
      else
        warn_test "Kiosk page may not include JavaScript"
      fi
    fi
  fi
  
  return 0
}

# ===========================================================================
# INTEGRATION & STRESS TESTS
# ===========================================================================

test_display_repaint_cycle() {
  test_case "Display Repaint Cycle (5 second check)"
  
  local start_time=$(date +%s)
  local count=0
  
  # Try to fetch the schedule API multiple times rapidly to simulate repaints
  for i in {1..5}; do
    if command -v timeout >/dev/null 2>&1; then
      if timeout 2s curl -s http://127.0.0.1:8000/api/schedule >/dev/null 2>&1; then
        count=$((count + 1))
      fi
    fi
    sleep 0.5
  done
  
  if [[ $count -ge 4 ]]; then
    pass_test "Display repaint cycle stable ($count/5 successful)"
  elif [[ $count -ge 2 ]]; then
    warn_test "Display repaint cycle unstable ($count/5 successful)"
  else
    fail_test "Display repaint cycle failing ($count/5 successful)"
  fi
  
  return 0
}

test_backend_long_run() {
  test_case "Backend Stability (10 second health check loop)"
  
  local failures=0
  
  for i in {1..10}; do
    if command -v timeout >/dev/null 2>&1; then
      if ! timeout 1s curl -fs http://127.0.0.1:8000/health >/dev/null 2>&1; then
        failures=$((failures + 1))
      fi
    fi
    sleep 1
  done
  
  if [[ $failures -eq 0 ]]; then
    pass_test "Backend sustained 10 health checks without failure"
  elif [[ $failures -lt 3 ]]; then
    warn_test "Backend had $failures failures in 10 health checks"
  else
    fail_test "Backend unstable ($failures/10 failures)"
  fi
  
  return 0
}

# ===========================================================================
# FALSE POSITIVE & FALSE NEGATIVE DETECTION
# ===========================================================================

test_spurious_hdmi_disconnect() {
  test_case "HDMI Stability Check (transient disconnect detection)"
  
  if ! [[ -d /sys/class/drm ]]; then
    warn_test "DRM not available; skipping HDMI stability check"
    return 0
  fi
  
  local connected_count=0
  for i in {1..3}; do
    if grep -q "connected" /sys/class/drm/card*-HDMI-A-*/status 2>/dev/null; then
      connected_count=$((connected_count + 1))
    fi
    sleep 0.5
  done
  
  if [[ $connected_count -eq 3 ]]; then
    pass_test "HDMI connection stable (3/3 checks connected)"
  elif [[ $connected_count -ge 2 ]]; then
    warn_test "HDMI connection unstable ($connected_count/3 checks connected)"
  else
    fail_test "HDMI connection problem detected"
  fi
  
  return 0
}

test_rendering_glitches() {
  test_case "Rendering Corruption Detection"
  
  # Check for known corruption patterns in syslog
  if command -v journalctl >/dev/null 2>&1; then
    local gpu_errors=$(journalctl -b --no-pager 2>/dev/null | grep -i "gpu\|gfx\|drm.*error" | wc -l || echo 0)
    
    if [[ $gpu_errors -eq 0 ]]; then
      pass_test "No GPU/DRM errors in journal"
    else
      warn_test "Found $gpu_errors GPU/DRM error entries in journal"
    fi
  fi
  
  return 0
}

# ===========================================================================
# TEST SUMMARY
# ===========================================================================

print_summary() {
  echo ""
  echo "=========================================="
  echo "DISPLAY PIPELINE TEST SUMMARY"
  echo "=========================================="
  echo "Tests run:     $TESTS_RUN"
  echo "Tests passed:  $TESTS_PASSED"
  echo "Tests failed:  $TESTS_FAILED"
  echo "Warnings:      $WARNINGS"
  echo ""
  
  if [[ $TESTS_FAILED -eq 0 ]]; then
    echo "✓ ALL TESTS PASSED" 
    return 0
  else
    echo "✗ SOME TESTS FAILED"
    return 1
  fi
}

# ===========================================================================
# MAIN TEST RUNNER
# ===========================================================================

main() {
  require_root
  print_info "Starting Display Pipeline Test Suite"
  
  # Layer 1: Hardware
  test_hdmi_detection
  test_drm_devices
  test_framebuffer
  test_gpu_memory
  
  # Layer 2: Display Manager & X
  test_lightdm_service
  test_x_server_socket
  test_x_display_responsive
  test_xrandr_display_modes
  
  # Layer 3: Chromium
  test_chromium_available
  test_bellforge_client_service
  
  # Layer 4: Backend
  test_backend_service
  test_backend_health
  test_kiosk_page
  test_schedule_api
  test_display_diagnostics_api
  
  # Layer 5: Application
  test_javascript_rendering
  
  # Integration
  test_display_repaint_cycle
  test_backend_long_run
  
  # Edge cases
  test_spurious_hdmi_disconnect
  test_rendering_glitches
  
  print_summary
}

main "$@"
