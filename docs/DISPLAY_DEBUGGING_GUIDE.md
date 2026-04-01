# Display Pipeline Debugging and Testing Guide

## Overview
This guide helps diagnose and fix the Raspberry Pi display corruption issue (random colored lines after restart).

The display pipeline has 5 layers, and we've added comprehensive diagnostics and tests for each:

1. **Hardware/Kernel** - HDMI, GPU, DRM
2. **Display Manager & X** - LightDM, X11 server
3. **Chromium** - Browser process
4. **Backend API** - FastAPI HTTP services
5. **Application** - JavaScript rendering, schedule display

## Deployment Steps

### Step 1: Deploy Enhanced Scripts

```bash
# On your development machine:
# Copy enhanced scripts to the Pi
scp backend/services/display_pipeline.py pi@<IP>:/opt/bellforge/backend/services/
scp backend/routes/diagnostics.py pi@<IP>:/opt/bellforge/backend/routes/
scp scripts/start_kiosk.sh pi@<IP>:/opt/bellforge/scripts/
scp scripts/gpu_diagnostics.py pi@<IP>:/opt/bellforge/scripts/
scp scripts/post_boot_capture.sh pi@<IP>:/opt/bellforge/scripts/
scp tests/test_display_pipeline.sh pi@<IP>:/opt/bellforge/tests/
scp tests/test_display_stress.sh pi@<IP>:/opt/bellforge/tests/

# SSH to Pi
ssh pi@<IP>
sudo -i
```

### Step 2: Capture Pre-Boot State

Before the display shows corruption, capture the initial state:

```bash
# On the Pi:
python3 /opt/bellforge/scripts/gpu_diagnostics.py > /tmp/before_boot.json
echo "Initial state captured"
```

### Step 3: Trigger Display Corruption

Reboot the Pi to reproduce the issue:

```bash
# On the Pi:
reboot
```

### Step 4: Capture Post-Boot State (Immediately After Boot)

SSH back in WHILE the display is showing colored lines:

```bash
# On your dev machine:
ssh pi@<IP> sudo /opt/bellforge/scripts/post_boot_capture.sh
```

This will create a directory `/tmp/bellforge-boot-capture/` with detailed diagnostics while the issue is visible.

### Step 5: Retrieve and Analyze Capture

```bash
# On your dev machine:
scp -r pi@<IP>:/tmp/bellforge-boot-capture /tmp/bellforge-diagnostics
scp pi@<IP>:/tmp/bellforge-gpu-diagnostics.json /tmp/
```

Review the captured files to identify which layer is failing:

**Key files to review:**
- `display_pipeline.json` - Shows health status, service state, HDMI connection
- `gpu_diagnostics.json` - Detailed GPU device, memory, thermal state
- `xrandr.txt` - Display resolution and mode info
- `xdpyinfo.txt` - X server state  
- `dmesg.log` - Kernel messages (GPU errors, HDMI negotiation)
- `journal.log` - systemd journal (service startup issues)
- `framebuffer.png` - Actual screenshot of corrupt display

## Quick Diagnostic API Endpoints

The backend now exposes these endpoints for quick diagnostics:

### Check Display Pipeline Health

```bash
curl http://127.0.0.1:8000/api/display/pipeline | jq .health,.issues
```

### Run GPU Reset Self-Heal

```bash
curl -X POST http://127.0.0.1:8000/api/display/self-heal \
  -H "Content-Type: application/json" \
  -d '{"action": "reset-gpu"}'
```

### Run Display Initialization

```bash
curl -X POST http://127.0.0.1:8000/api/display/self-heal \
  -H "Content-Type: application/json" \
  -d '{"action": "force-hdmi-mode"}'
```

## Running Test Suites

### Full Display Pipeline Test

This tests all 5 layers of the pipeline:

```bash
sudo /opt/bellforge/tests/test_display_pipeline.sh
```

**Expects ~25+ tests to pass. Note any warning or failure.**

### Stress Test

This hammers the display system under load for 60 seconds:

```bash
sudo BELLFORGE_STRESS_DURATION=60 /opt/bellforge/tests/test_display_stress.sh
```

**Monitor for error rates >5%, which indicate instability.**

## Enhanced start_kiosk.sh Features

The startup script now has diagnostic modes. Enable via environment variables:

```bash
# Enable GPU diagnostics
DEBUG_KIOSK=1 /opt/bellforge/scripts/start_kiosk.sh

# Enable boot diagnostics  
BELLFORGE_DIAG_BOOT=1 /opt/bellforge/scripts/start_kiosk.sh

# Set GPU initialization delay (default 8 seconds)
BELLFORGE_GPU_INIT_DELAY=10 /opt/bellforge/scripts/start_kiosk.sh
```

These will print detailed logs to systemd journal:

```bash
journalctl -u bellforge-client -f
```

## Key Improvements Made

### 1. Enhanced Diagnostics
- GPU memory pressure monitoring
- Thermal throttle detection
- Display mode validation via xrandr
- Framebuffer integrity checks
- HDMI EDID detection
- X server responsiveness checks

### 2. Improved Startup Timing
- 8-second GPU initialization delay (configurable)
- Framebuffer clearing before Chromium launch
- EDID-based HDMI detection
- Display mode setting before browser start
- Memory flushing with `sync`

### 3. New Self-Heal Actions
- `reset-gpu` - Reset GPU bus
- `clear-framebuffer` - Clear FB memory
- `force-hdmi-mode` - Set HDMI to 1920x1080@60Hz
- `cold-reboot` - Soft reboot with delay

### 4. Comprehensive Testing
- 20+ layer-by-layer tests
- Concurrent API stress tests
- Memory leak detection
- Thermal stability monitoring
- Rendering corruption detection

## Expected Behaviors & False Positive Handling

### False Positives to Ignore
- HDMI show as "disconnected" if TV is off (expected)
- X not responsive for first 30 seconds after lightdm starts (expected)
- Memory pressure >75% during boot (expected, stabilizes)
- GPU temperature ramp during first minute (expected)

### Real Issues to Fix
- HDMI connection unstable (disconnects >1 per minute)
- X never becomes responsive (>45 seconds)
- Framebuffer write failures
- GPU thermal throttle (>85°C)
- Memory pressure stays >90% (memory leak)
- Backend health checks failing >10% of time

## Iteration Process

1. **Identify the failing layer** using diagnostic files
2. **Apply targeted fix** (see suggested fixes below)
3. **Test fix** with appropriate test from Step 7-8
4. **Reboot and verify** the fix survives reboot
5. **Repeat** until all tests pass

## Suggested Fixes by Layer

### If Layer 1 (Hardware/Kernel) is failing:
```bash
# Increase GPU init delay
sudo nano /etc/environment
# Add: BELLFORGE_GPU_INIT_DELAY=15

# Or try TV firmware reset:
vcgencmd display_power 1 1
```

### If Layer 2 (LightDM/X) is failing:
```bash
# Restart LightDM service
sudo systemctl restart lightdm.service

# Or force HDMI mode:
curl -X POST http://127.0.0.1:8000/api/display/self-heal \
  -d '{"action": "force-hdmi-mode"}'
```

### If Layer 3 (Chromium) is failing:
```bash
# Restart browser service
sudo systemctl restart bellforge-client.service

# Or check Chromium logs:
journalctl -u bellforge-client -n 50
```

### If Layer 4 (Backend) is failing:
```bash
# Restart backend
sudo systemctl restart bellforge-backend.service

# Check for memory leaks:
curl http://127.0.0.1:8000/api/display/pipeline | jq '.gpu_diagnostics.memory_pressure'
```

### If Layer 5 (Application) is failing:
Check [client/js/main.js](../client/js/main.js) for rendering issues.

## Collecting Data for Remote Debugging

If you need help debugging remotely:

```bash
# Create comprehensive debug bundle
script_dir="/tmp/bellforge-debug-$(date +%s)"
mkdir -p "$script_dir"

sudo python3 /opt/bellforge/scripts/gpu_diagnostics.py > "$script_dir/gpu_diag.json"
sudo journalctl -b > "$script_dir/journal.txt"
dmesg > "$script_dir/dmesg.txt"
curl -s http://127.0.0.1:8000/api/display/pipeline > "$script_dir/pipeline.json"
systemctl status bellforge-* > "$script_dir/services.txt" 2>&1

# Download to development machine
# scp -r pi@<IP>:$script_dir /tmp/bellforge-remote-debug

echo "Debug bundle: $script_dir"
```

## Next Steps

1. Deploy the enhanced scripts to the Pi
2. Reboot and capture the boot state (Steps 3-5)
3. Run the test suites (Step 7-8)
4. Identify which layer is failing
5. Apply fixes iteratively
6. Document the root cause and solution

---

**Questions?** Check the service logs:
```bash
journalctl -u bellforge-backend -n 100
journalctl -u bellforge-client -n 100
journalctl -u lightdm -n 100
```
