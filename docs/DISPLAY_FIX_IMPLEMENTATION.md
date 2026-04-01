# Display Pipeline Fix - Implementation Summary

## Problem Statement
Raspberry Pi displays random colored lines and corruption after restart, persisting even after multiple reboots. This indicates a display driver/GPU initialization issue rather than application logic.

## Root Cause Analysis

The display pipeline has 5 layers, each of which can fail:

1. **Kernel/Hardware Layer** - GPU driver initialization, HDMI negotiation
2. **Display Manager (LightDM) & X Server** - Display mode setup, framebuffer allocation
3. **Chromium Browser** - Graphics rendering, X11 connection
4. **Backend API** - HTTP service health and response time
5. **Application Logic** - JavaScript rendering, schedule display

**Suspected Root Causes for Random Corruption:**
- Race condition: Chromium starts before GPU/X is ready
- GPU memory corruption from uncleared framebuffer
- Display mode mismatch between HDMI negotiated resolution and X configuration
- HDMI EDID parsing delay causing transient disconnection
- Thermal throttling during boot causing GPU malfunction
- Missing memory flush synchronization

## Implementation

### Phase 1: Enhanced Diagnostics ✅

#### 1.1 GPU & Thermal Diagnostics (`backend/services/display_pipeline.py`)

Added `_gpu_diagnostics()` function that collects:
- GPU driver load status
- GPU memory pressure monitoring
- Thermal status and throttle detection
- System memory availability
- Power management state

Added `_display_mode_info()` function that collects:
- Current display resolution via xrandr
- HDMI EDID availability
- X server socket status
- DRM mode information

Added `_framebuffer_integrity()` function that checks:
- /dev/fb0 device existence and permissions
- Framebuffer color mapping
- Framebuffer size and configuration

#### 1.2 Diagnostics API Updates (`backend/routes/diagnostics.py`)

Updated `DisplaySelfHealPayload` to support new actions:
- `reset-gpu` - Reset GPU bus via /sys interface
- `clear-framebuffer` - Wipe framebuffer memory
- `force-hdmi-mode` - Set HDMI to 1920x1080@60Hz
- `cold-reboot` - Soft reboot with 2-second delay

### Phase 2: Improved Startup Sequence ✅

#### 2.1 Enhanced `scripts/start_kiosk.sh`

Added comprehensive GPU initialization:

```bash
# Key improvements:
- GPU_INIT_DELAY: Configurable 8-second wait for GPU to stabilize
- Framebuffer clearing before Chromium launch
- Display mode setting via xrandr
- Memory flushing with sync command
- EDID-based HDMI detection
- Thermal monitoring
- Comprehensive logging with debug modes
```

New diagnostic modes:
- `DEBUG_KIOSK=1` - Enable GPU diagnostics on startup
- `BELLFORGE_DIAG_BOOT=1` - Boot diagnostics (disk, memory, uptime)
- `BELLFORGE_GPU_INIT_DELAY=X` - Customize GPU init wait (default 8)

New functions:
- `diagnose_gpu()` - Collect GPU state info
- `diagnose_boot()` - Collect boot-time system state
- `init_gpu()` - Initialize GPU, clear FB, set display mode
- `validate_network()` - Check backend connectivity

### Phase 3: Comprehensive Testing ✅

#### 3.1 Main Test Suite (`tests/test_display_pipeline.sh`)

20+ tests covering all 5 layers:

**Layer 1 - Hardware (4 tests):**
- HDMI cable detection
- DRM device availability
- Framebuffer device existence
- GPU memory and thermal status

**Layer 2 - Display Manager & X (4 tests):**
- LightDM service status
- X display socket availability
- X server responsiveness
- Display mode detection via xrandr

**Layer 3 - Chromium (2 tests):**
- Chromium binary availability
- Client service status

**Layer 4 - Backend (4 tests):**
- Backend service active
- Health endpoint reachable
- Kiosk page loads
- Schedule API functional
- Display diagnostics API functional

**Layer 5 - Application (1 test):**
- JavaScript rendering detection

**Integration (2 tests):**
- Display repaint cycle stability
- Backend sustained health checks

**Edge Cases (2 tests):**
- HDMI stability (transient disconnect detection)
- Rendering glitch detection via journal

#### 3.2 Stress Test Suite (`tests/test_display_stress.sh`)

Concurrent load testing for 60 seconds (configurable):

- **API Endpoint Hammering** - Random requests to all endpoints
- **Backend Resource Usage** - Memory leak detection
- **X Server Stability** - Continuous responsiveness checks
- **Display Mode Switching** - Rapid mode changes
- **GPU Memory Access** - Framebuffer write patterns
- **Thermal Monitoring** - Temperature stability

Provides error rates and identifies instability patterns.

### Phase 4: Diagnostic Tools ✅

#### 4.1 Deep GPU Diagnostics (`scripts/gpu_diagnostics.py`)

Collects JSON output with:
- Boot timeline and startup analysis
- GPU device information (PCI, DRM, device tree)
- Display mode configuration
- Framebuffer status
- GPU memory allocation
- Thermal status
- X server status
- Chromium process information
- Kernel module status
- Service health

#### 4.2 Post-Boot Capture (`scripts/post_boot_capture.sh`)

Immediate data collection after boot while corruption is visible:
- Display pipeline diagnostics
- GPU diagnostics
- Kernel dmesg logs
- Systemd journal
- X display state (xdpyinfo, xrandr)
- Service status
- Framebuffer screenshot (if possible)

#### 4.3 Display Repair Tool (`scripts/repair_display.sh`)

Interactive repair with 4 escalation levels:

1. **QUICK (30 sec)** - Clear FB, restart services
2. **MEDIUM (45 sec)** - GPU reset, display mode set
3. **DEEP (60 sec)** - Reload GPU kernel modules
4. **COLD-REBOOT (2 min)** - Full system reboot

### Phase 5: Documentation ✅

#### 5.1 Display Debugging Guide (`docs/DISPLAY_DEBUGGING_GUIDE.md`)

Complete guide covering:
- Problem overview and root cause analysis
- 5-layer display pipeline breakdown
- Deployment steps (5 detailed steps)
- API diagnostic endpoints
- Test suite usage
- Key improvements overview
- False positive/negative handling
- Iteration process
- Suggested fixes by layer
- Remote debugging procedures

### Phase 6: Deployment Tools ✅

#### 6.1 Deployment Script (`scripts/deploy_display_fixes.sh`)

Automated deployment to Pi:
```bash
./scripts/deploy_display_fixes.sh 192.168.1.100 pi
```

Deploys all enhanced scripts, tests, and documentation, sets permissions, and restarts backend.

## Files Modified/Created

### Modified Files
- `backend/services/display_pipeline.py` - Added 3 new diagnostic functions, enhanced issue detection
- `backend/routes/diagnostics.py` - Added 4 new self-heal actions to payload
- `scripts/start_kiosk.sh` - Complete rewrite with GPU init, diagnostics, timing improvements
- `client/index.html` - (no changes needed)
- `client/js/main.js` - (no changes needed)

### Created Files
- `tests/test_display_pipeline.sh` - New comprehensive test suite (450+ lines)
- `tests/test_display_stress.sh` - New stress test suite (350+ lines)
- `scripts/gpu_diagnostics.py` - New diagnostic tool (350+ lines)
- `scripts/post_boot_capture.sh` - New boot capture tool (100+ lines)
- `scripts/repair_display.sh` - New repair utility (200+ lines)
- `scripts/deploy_display_fixes.sh` - New deployment tool (100+ lines)
- `docs/DISPLAY_DEBUGGING_GUIDE.md` - New comprehensive guide (300+ lines)

## How to Use

### Deployment

```bash
cd /path/to/BellForge
./scripts/deploy_display_fixes.sh 192.168.1.100 pi
```

### Diagnosing the Issue

1. **Reboot the Pi and capture the corrupted state:**
```bash
ssh pi@192.168.1.100 sudo /opt/bellforge/scripts/post_boot_capture.sh
scp -r pi@192.168.1.100:/tmp/bellforge-boot-capture ~/bellforge-debug
```

2. **Review captured files to identify which layer is failing:**
   - Check `display_pipeline.json` for health status
   - Check `xrandr.txt` for display resolution issues
   - Check `dmesg.log` for GPU/DRM errors
   - Check `framebuffer.png` for visual corruption pattern

3. **Run diagnostic tests to narrow down the issue:**
```bash
ssh pi@192.168.1.100 sudo /opt/bellforge/tests/test_display_pipeline.sh
```

4. **Check real-time diagnostics via API:**
```bash
curl http://192.168.1.100:8000/api/display/pipeline | jq .
```

### Fixing the Issue

Based on your diagnostics, apply targeted fixes:

**Quick fix (no reboot):**
```bash
ssh pi@192.168.1.100 sudo /opt/bellforge/scripts/repair_display.sh 1
```

**Medium fix (GPU reset, no reboot):**
```bash
ssh pi@192.168.1.100 sudo /opt/bellforge/scripts/repair_display.sh 2
```

**Deep fix (kernel modules):**
```bash
ssh pi@192.168.1.100 sudo /opt/bellforge/scripts/repair_display.sh 3
```

**Cold reboot:**
```bash
ssh pi@192.168.1.100 sudo /opt/bellforge/scripts/repair_display.sh 4
```

### Monitoring

Check display health continuously:
```bash
watch -n 5 'curl -s http://192.168.1.100:8000/api/display/pipeline | jq ".health, .issues"'
```

## Key Metrics & Thresholds

| Metric | Normal | Warning | Critical |
|--------|--------|---------|----------|
| Memory Pressure | <50% | 50-75% | >75% |
| GPU Temperature | <70°C | 70-80°C | >80°C |
| API Error Rate | <1% | 1-5% | >5% |
| Backend Health | 100% | 95-100% | <95% |
| HDMI Connection Stability | 100% | 95-100% | <95% |
| Display Mode Success | 100% | 95-100% | <95% |

## Testing Results Expected

After deployment, running the test suite should show:

```
✓ HDMI Connection Detected
✓ DRM Devices Available (1-2 devices)
✓ Framebuffer Device Present
✓ GPU Memory Pressure Normal
✓ LightDM Service Active and Enabled
✓ X Display Socket Ready
✓ X Server Responsive
✓ Display Modes Detected (1920x1080, etc)
✓ Chromium Binary Found
✓ Client Service Active and Enabled
✓ Backend Service Active
✓ Backend Health Endpoint Reachable
✓ Kiosk Page Loads Successfully
✓ Schedule API Functional
✓ Display Diagnostics API Functional
... [18+ total tests]
```

Warnings about memory pressure or thermal status are expected during boot; these should stabilize within 2 minutes.

## Iteration Process

If tests still fail after deployment:

1. **Identify the failing layer** using test output
2. **Apply targeted fix** from repair tool or manual intervention
3. **Re-test** that specific layer
4. **Document the failure pattern** in `/tmp/bellforge-boot-capture`
5. **Consider hardware issues** if multiple reboots don't help
   - Check HDMI cable
   - Try different TV/monitor
   - Check GPU cooling
   - Test with minimal OS

## Known Limitations & Future Improvements

### Current Limitations
- Tests assume systemctl is available (should work on all modern Raspberry Pi OS)
- Some tests require X server (will skip gracefully if unavailable)
- Diagnostic script collection depends on various tools being installed
- repair_display.sh kernel module reload may not work on all Pi models

### Potential Future Improvements
- Implement DRM-based direct rendering as fallback (bypass X11)
- Add GPU memory statistics from /proc/memstat
- Implement automated fix selection based on diagnostic output
- Add performance profiling during rendering
- Create containerized display pipeline with guaranteed startup order
- Implement GPU command stream validation

## Support & Debugging

### Quick Diagnostic Check
```bash
ssh pi@192.168.1.100
python3 /opt/bellforge/scripts/gpu_diagnostics.py | jq '.display_mode,.thermal,.services'
```

### Collect Full Debug Bundle
```bash
ssh pi@192.168.1.100 "
  sudo /opt/bellforge/scripts/post_boot_capture.sh && \
  tar -czf /tmp/bellforge-debug.tar.gz /tmp/bellforge-boot-capture && \
  du -h /tmp/bellforge-debug.tar.gz
"
scp pi@192.168.1.100:/tmp/bellforge-debug.tar.gz ~/bellforge-debug.tar.gz
```

### Check Live System Health
```bash
# Terminal 1: Monitor display health
watch -n 2 'curl -s http://192.168.1.100:8000/api/display/pipeline | jq .'

# Terminal 2: Check service logs
ssh pi@192.168.1.100 'journalctl -u bellforge-client -f'

# Terminal 3: Run stress test
ssh pi@192.168.1.100 'sudo /opt/bellforge/tests/test_display_stress.sh'
```

---

**Summary:** A comprehensive 5-layer debugging and repair framework has been implemented for the Raspberry Pi display corruption issue. Deploy the enhanced scripts, capture initial diagnostics after a reboot, and use the test suites and repair tools to iteratively fix the underlying issue. All 5 layers of the display pipeline now have detailed diagnostics and self-recovery mechanisms.
