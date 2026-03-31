# BellForge Product Requirements Document (PRD)

## 1. Purpose and Vision

BellForge is a Raspberry Pi-based, schedule-aware digital signage platform designed for school environments. It delivers reliable, always-on classroom or hallway displays while keeping operational overhead low for school IT teams.

Vision:
- Make school signage operationally boring: predictable, resilient, and easy to maintain.
- Enable near-zero-touch fleet management for distributed Raspberry Pi displays.
- Provide a clear path from static display content to richer, school-aware experiences.

## 2. Target Users

- Teachers:
  - Need dependable classroom/hallway schedule visibility.
  - Need minimal setup and no daily maintenance burden.
- Students:
  - Need clear period timing, transitions, and school-day context.
  - Need high-visibility, always-current information.
- IT Staff:
  - Need centralized update control and observability.
  - Need easy install, repair, and uninstall workflows.
  - Need safe, repeatable release and rollback-ready operations.

## 3. Core Features

### 3.1 Raspberry Pi Signage Client
- Chromium kiosk display on Raspberry Pi OS.
- Full-screen, unattended operation.
- Pulls schedule and version metadata from the backend.
- Handles offline periods gracefully with cached state where possible.

### 3.2 FastAPI Backend
- Exposes version, manifest, schedule, and file-delivery APIs.
- Hosts display payloads/content endpoints.
- Supports broadcast trigger requests for immediate update checks.

### 3.3 Autoupdate System
- Manifest-based update orchestration (`config/manifest.json`).
- Version gating via `config/version.json`.
- Selective file download based on SHA-256 drift detection.
- Atomic staging and managed-root swap to avoid partial live updates.
- Optional reboot policy and service restart handling.

### 3.4 Installer, Repair, and Uninstall Workflows
- Unified installer entrypoint (`install.sh`) with action flags.
- Repair mode restores missing/corrupt files and service units.
- Uninstall mode removes services and install footprint (with optional purge).

### 3.5 Schedule-Aware Content Delivery
- Backend serves canonical schedule data (`config/schedule.json`).
- Client computes current period, next period, and countdown state.
- Display routing supports per-display payload behavior.

### 3.6 Test Suite and Release Workflow
- Scripted install, repair, uninstall, and smoke validation.
- Release preparation validates tests, manifest integrity, and payload downloadability.
- Version/manifest generation is automated and repeatable.

## 4. Non-Functional Requirements

### 4.1 Reliability
- Services must auto-restart on failure via systemd.
- Update workflow must avoid leaving devices in inconsistent states.
- Repair path must restore operational baseline from degraded states.

### 4.2 Zero-Touch Updates
- Devices should self-check and self-apply updates on poll interval.
- Fleet operators should not need per-device manual patching in normal operation.

### 4.3 Offline Tolerance
- Client must continue rendering usable display state during temporary backend outages.
- Updater should retry failed update attempts and recover on next poll cycle.

### 4.4 Simplicity for Non-Technical Users
- One-line install flow for fresh devices.
- Predictable service naming and straightforward status checks.
- Clear logs and operational scripts for support staff.

## 5. Constraints

- Must run on Raspberry Pi OS.
- Must support kiosk mode operation (Chromium full-screen).
- Must support selective file updates (do not require full image redeploy for every change).

## 6. Success Criteria

- Fresh Pi can be provisioned to operational signage via one scripted workflow.
- Routine updates are applied automatically without manual SSH intervention.
- Repair workflow can recover from common corruption/missing-file scenarios.
- Test suite catches regressions in install/repair/uninstall/release-critical paths.

## 7. Future Roadmap

- Admin UI:
  - Web interface for schedule, payload, and fleet status management.
- Classroom logic:
  - Context-aware layouts and rules per room, grade, or day type.
- Countdown widgets:
  - Additional modular widgets for exams, events, and transitions.
- Multi-display orchestration:
  - Centralized grouping, phased rollouts, and coordinated content control.
