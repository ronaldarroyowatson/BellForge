#!/usr/bin/env bash
set -euo pipefail

# Display Pipeline Stress Test
# Exercises various parts of the pipeline under load to detect:
# - Race conditions in rendering
# - Memory leaks
# - GPU resource exhaustion
# - Intermittent connection issues
# - Framebuffer corruption triggers

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

TEST_LOG_DIR="${TEST_LOG_DIR:-/tmp/bellforge-tests}"
mkdir -p "$TEST_LOG_DIR"

LOG_FILE="${TEST_LOG_DIR}/display_stress.log"
exec > >(tee "$LOG_FILE") 2>&1

STRESS_DURATION="${BELLFORGE_STRESS_DURATION:-60}"
NUM_CONCURRENT="${BELLFORGE_STRESS_CONCURRENT:-10}"

# Counters
REQUESTS_SENT=0
REQUESTS_OK=0
REQUESTS_FAILED=0
ERRORS_SEEN=()

log_request() {
  local result="$1"
  local endpoint="$2"
  local code="${3:-}"
  
  if [[ "$result" == "ok" ]]; then
    REQUESTS_OK=$((REQUESTS_OK + 1))
  else
    REQUESTS_FAILED=$((REQUESTS_FAILED + 1))
    if [[ -n "$code" ]]; then
      ERRORS_SEEN+=("$code")
    fi
  fi
}

# ===========================================================================
# STRESS TEST: API ENDPOINT HAMMERING
# ===========================================================================

stress_api_endpoints() {
  echo ""
  echo "========== STRESS TEST: API Endpoint Hammering =========="
  echo "Duration: ${STRESS_DURATION}s, Concurrency: ${NUM_CONCURRENT}"
  
  local end_time=$(($(date +%s) + STRESS_DURATION))
  local pid_array=()
  
  # Launch concurrent request workers
  for worker_id in $(seq 1 "$NUM_CONCURRENT"); do
    {
      while (( $(date +%s) < end_time )); do
        # Randomly choose endpoint
        local endpoint_choice=$((RANDOM % 4))
        
        case $endpoint_choice in
          0)
            # Health check
            if timeout 2s curl -fs http://127.0.0.1:8000/health >/dev/null 2>&1; then
              log_request "ok" "/health"
            else
              log_request "fail" "/health" "timeout"
            fi
            ;;
          1)
            # Schedule fetch
            if timeout 2s curl -fs http://127.0.0.1:8000/api/schedule >/dev/null 2>&1; then
              log_request "ok" "/api/schedule"
            else
              log_request "fail" "/api/schedule" "timeout"
            fi
            ;;
          2)
            # Kiosk page
            if timeout 2s curl -fs http://127.0.0.1:8000/client/index.html >/dev/null 2>&1; then
              log_request "ok" "/client/index.html"
            else
              log_request "fail" "/client/index.html" "timeout"
            fi
            ;;
          3)
            # Display diagnostics
            if timeout 3s curl -fs http://127.0.0.1:8000/api/display/pipeline >/dev/null 2>&1; then
              log_request "ok" "/api/display/pipeline"
            else
              log_request "fail" "/api/display/pipeline" "timeout"
            fi
            ;;
        esac
        
        REQUESTS_SENT=$((REQUESTS_SENT + 1))
        
        # Small delay to avoid overwhelming
        sleep 0.1
      done
    } &
    pid_array+=($!)
  done
  
  # Wait for all workers
  for pid in "${pid_array[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  
  echo "Requests sent:   $REQUESTS_SENT"
  echo "Requests OK:     $REQUESTS_OK"
  echo "Requests FAILED: $REQUESTS_FAILED"
  
  if [[ ${#ERRORS_SEEN[@]} -gt 0 ]]; then
    echo "Unique errors encountered:"
    printf '%s\n' "${ERRORS_SEEN[@]}" | sort | uniq -c | sort -rn
  fi
  
  local error_rate=0
  if (( REQUESTS_SENT > 0 )); then
    error_rate=$(( REQUESTS_FAILED * 100 / REQUESTS_SENT ))
  fi
  
  if (( error_rate < 5 )); then
    echo "✓ API endpoint stress: PASSED (error rate < 5%)"
  elif (( error_rate < 10 )); then
    echo "⚠ API endpoint stress: WARNING (error rate $error_rate%)"
  else
    echo "✗ API endpoint stress: FAILED (error rate $error_rate%)"
  fi
}

# ===========================================================================
# STRESS TEST: BACKEND RESOURCE USAGE
# ===========================================================================

stress_backend_resources() {
  echo ""
  echo "========== STRESS TEST: Backend Resource Usage =========="
  
  local initial_mem=0
  local peak_mem=0
  
  # Get initial memory usage
  if ps aux | grep -q "[b]ellforge-backend"; then
    initial_mem=$(ps aux | grep "[b]ellforge-backend" | awk '{print $6}')
    peak_mem=$initial_mem
    echo "Initial backend memory: ${initial_mem} KB"
  fi
  
  # Hammer the backend for a bit
  local req_count=0
  for i in {1..200}; do
    timeout 1s curl -fs http://127.0.0.1:8000/health >/dev/null 2>&1 || true
    req_count=$((req_count + 1))
    sleep 0.05
  done
  
  echo "Sent $req_count requests to backend"
  
  # Check final memory
  if ps aux | grep -q "[b]ellforge-backend"; then
    peak_mem=$(ps aux | grep "[b]ellforge-backend" | awk '{print $6}')
    echo "Peak backend memory: ${peak_mem} KB"
    
    local mem_increase=$((peak_mem - initial_mem))
    echo "Memory increase: ${mem_increase} KB"
    
    if (( mem_increase < 50000 )); then
      echo "✓ Backend memory usage: STABLE"
    elif (( mem_increase < 100000 )); then
      echo "⚠ Backend memory: SLIGHT GROWTH (${mem_increase}KB)"
    else
      echo "✗ Backend memory: POTENTIAL LEAK (${mem_increase}KB)"
    fi
  fi
}

# ===========================================================================
# STRESS TEST: X SERVER STABILITY
# ===========================================================================

stress_x_server() {
  echo ""
  echo "========== STRESS TEST: X Server Stability =========="
  
  if ! command -v xrandr >/dev/null 2>&1; then
    echo "xrandr not available; skipping X server stress test"
    return 0
  fi
  
  local x_ok_count=0
  local x_fail_count=0
  
  for i in {1..20}; do
    if DISPLAY=:0 timeout 1s xdpyinfo >/dev/null 2>&1; then
      x_ok_count=$((x_ok_count + 1))
    else
      x_fail_count=$((x_fail_count + 1))
    fi
    sleep 0.25
  done
  
  echo "X display checks OK:   $x_ok_count/20"
  echo "X display checks FAIL: $x_fail_count/20"
  
  if (( x_fail_count == 0 )); then
    echo "✓ X server stability: PASSED"
  elif (( x_fail_count < 3 )); then
    echo "⚠ X server stability: MINOR GLITCHES ($x_fail_count failures)"
  else
    echo "✗ X server stability: UNSTABLE ($x_fail_count/20 failures)"
  fi
}

# ===========================================================================
# STRESS TEST: DISPLAY MODE SWITCHING
# ===========================================================================

stress_display_modes() {
  echo ""
  echo "========== STRESS TEST: Display Mode Switching =========="
  
  if ! command -v xrandr >/dev/null 2>&1; then
    echo "xrandr not available; skipping display mode stress test"
    return 0
  fi
  
  # Get available display
  local display=$(DISPLAY=:0 xrandr 2>/dev/null | grep " connected" | head -1 | awk '{print $1}')
  
  if [[ -z "$display" ]]; then
    echo "No connected display found"
    return 0
  fi
  
  echo "Testing display mode changes on $display..."
  
  local modes_found=0
  local mode_changes=0
  
  # Get available modes
  local available_modes=$(DISPLAY=:0 xrandr 2>/dev/null | grep -A 20 "^$display" | grep -oP '\d+x\d+' | sort -u | head -3)
  
  for mode in $available_modes; do
    if DISPLAY=:0 timeout 1s xrandr --output "$display" --mode "$mode" 2>/dev/null; then
      mode_changes=$((mode_changes + 1))
      sleep 0.2
    fi
    modes_found=$((modes_found + 1))
  done
  
  echo "Display modes tested: $modes_found"
  echo "Successful mode changes: $mode_changes"
  
  if (( mode_changes == modes_found )); then
    echo "✓ Display mode switching: STABLE"
  else
    echo "⚠ Display mode switching: SOME FAILURES ($mode_changes/$modes_found)"
  fi
}

# ===========================================================================
# STRESS TEST: GPU ACCESS & MEMORY
# ===========================================================================

stress_gpu_memory() {
  echo ""
  echo "========== STRESS TEST: GPU Memory Access =========="
  
  if [[ ! -e /dev/fb0 ]]; then
    echo "/dev/fb0 not available; skipping GPU memory stress test"
    return 0
  fi
  
  echo "Testing framebuffer write patterns..."
  
  local write_ok=0
  local write_fail=0
  
  for i in {1..10}; do
    if dd if=/dev/zero of=/dev/fb0 bs=1M count=1 2>/dev/null; then
      write_ok=$((write_ok + 1))
    else
      write_fail=$((write_fail + 1))
    fi
    sleep 0.1
  done
  
  echo "Framebuffer writes OK:   $write_ok/10"
  echo "Framebuffer writes FAIL: $write_fail/10"
  
  if (( write_fail == 0 )); then
    echo "✓ GPU memory access: STABLE"
  elif (( write_fail < 3 )); then
    echo "⚠ GPU memory access: MINOR ISSUES ($write_fail failures)"
  else
    echo "✗ GPU memory access: UNSTABLE ($write_fail/10 failures)"
  fi
}

# ===========================================================================
# STRESS TEST: THERMAL MONITORING
# ===========================================================================

stress_thermal_monitoring() {
  echo ""
  echo "========== STRESS TEST: Thermal Stability =========="
  
  if [[ ! -f /sys/class/thermal/thermal_zone0/temp ]]; then
    echo "Thermal zone not available"
    return 0
  fi
  
  local temp_samples=0
  local max_temp=0
  local sum_temp=0
  
  for i in {1..20}; do
    local temp_mk=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)
    local temp_c=$((temp_mk / 1000))
    
    if (( temp_c > max_temp )); then
      max_temp=$temp_c
    fi
    
    sum_temp=$((sum_temp + temp_c))
    temp_samples=$((temp_samples + 1))
    
    sleep 0.5
  done
  
  local avg_temp=$((sum_temp / temp_samples))
  echo "Temperature samples: $temp_samples"
  echo "Average temperature: ${avg_temp}°C"
  echo "Maximum temperature: ${max_temp}°C"
  
  if (( max_temp < 70 )); then
    echo "✓ Thermal stability: EXCELLENT"
  elif (( max_temp < 80 )); then
    echo "⚠ Thermal stability: NORMAL"
  elif (( max_temp < 85 )); then
    echo "⚠ Thermal stability: ELEVATED (approaching throttle)"
  else
    echo "✗ Thermal stability: CRITICAL (throttling risk)"
  fi
}

# ===========================================================================
# CLEANUP & SUMMARY
# ===========================================================================

print_stress_summary() {
  echo ""
  echo "=========================================="
  echo "STRESS TEST SUMMARY"
  echo "=========================================="
  echo "Total requests sent: $REQUESTS_SENT"
  echo "Successful: $REQUESTS_OK"
  echo "Failed: $REQUESTS_FAILED"
  
  if (( REQUESTS_SENT > 0 )); then
    local error_pct=$((REQUESTS_FAILED * 100 / REQUESTS_SENT))
    echo "Error rate: ${error_pct}%"
  fi
}

main() {
  require_root
  print_info "Starting Display Pipeline Stress Test"
  
  stress_api_endpoints
  stress_backend_resources
  stress_x_server
  stress_display_modes
  stress_gpu_memory
  stress_thermal_monitoring
  
  print_stress_summary
  print_ok "Stress test completed"
}

main "$@"
