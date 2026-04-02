# Auth Test Suite Guide

## Overview

BellForge auth integrity is enforced by a dedicated suite covering:
- Cloud provider flows (Google, Microsoft, Apple, GitHub)
- Local-only auth flows (register, login, lockout, password reset)
- Device inheritance and authorization
- Security and edge cases (replay, expired tokens, malformed tokens, conflicts)

## Running the Suite

Use either Python or npm entrypoints:

```bash
python tests/run_auth_suite.py --coverage
python tests/run_auth_suite.py --parallel
npm test
npm run test:auth
npm run test:auth:parallel
```

## Coverage Gate

Coverage is enforced with:
- Minimum threshold: 80%
- Included auth surfaces:
  - `backend/services/unified_auth.py`
  - `backend/routes/auth_api.py`
  - `backend/routes/devices.py`

Coverage dependency is listed in `tests/requirements-auth.txt`.

## CI Enforcement

Workflow:
- `.github/workflows/auth-tests.yml`

Behavior:
- Runs on PRs to `main`
- Runs on pushes to `bugfix/**`, `hotfix/**`, and `main`
- Fails build on any auth regression or coverage drop below threshold

## Bugfix Workflow Enforcement

Auth suite is required in:
- `.github/workflows/bugfix-smoke.yml`
- `.github/workflows/release.yml`

This prevents automated patch/version bump release progression when auth tests fail.

## Local Pre-Push Gate

A Git pre-push hook is provided:
- `.githooks/pre-push`

Install once per clone:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-push
```

After this, pushes are blocked unless `python tests/run_auth_suite.py --coverage` succeeds.

## Test Inventory

Auth-focused test files:
- `tests/test_unified_auth_unit.py`
- `tests/test_unified_auth_integration.py`
- `tests/test_unified_auth_e2e.py`
- `tests/test_unified_auth_local_unit.py`
- `tests/test_unified_auth_local_integration.py`

Keep all new auth bugfixes accompanied by tests in one of these files or new `test_unified_auth_*.py` modules.
