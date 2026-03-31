# BellForge Coding Conventions and Style Guide

## 1. Principles

- Prefer clarity over cleverness.
- Keep behavior predictable for school IT operations.
- Optimize for safe updates and easy repairs.
- Write code for maintainers, not just for runtime.

## 2. Python Conventions

Target:
- Python 3.11+

Required style:
- Use full type hints on public functions, methods, and key internal helpers.
- Keep FastAPI endpoints async where appropriate.
- Favor small, single-purpose functions over large multi-branch blocks.
- Prefer explicit data contracts (Pydantic models, typed dict patterns, dataclasses).

Recommended practices:
- Use `pathlib.Path` instead of manual path string logic.
- Keep network operations bounded with explicit timeouts.
- Raise actionable errors and include context in logs.
- Keep update-critical logic deterministic and testable.

## 3. JavaScript Conventions

Target:
- Modern ECMAScript (ES2020+).

Required style:
- Use `const` by default; use `let` only for reassignment.
- Keep browser code framework-free unless explicitly requested.
- Build small pure helpers for schedule/time logic.
- Keep client rendering resilient during backend/network failures.

Recommended practices:
- Escape/render external strings safely.
- Avoid hidden global state when possible.
- Keep UI update loops simple and traceable.

## 4. Bash Conventions

Baseline:
- Start scripts with `set -euo pipefail` (or stricter equivalent where needed).

Required style:
- Scripts must be idempotent where feasible.
- Validate prerequisites early (root, binaries, environment vars).
- Use consistent logging helpers (`print_info`, `log`, `print_fail`, etc.).
- Avoid interactive prompts in CI paths; support explicit non-interactive flags.

Recommended practices:
- Keep side effects localized in named functions.
- Trap/cleanup temporary resources and background processes.
- Use shellcheck-friendly patterns.

## 5. Folder Structure Rules

- `backend/`: server-side API and delivery logic only.
- `client/`: browser signage code only.
- `updater/`: Pi-side update orchestration only.
- `scripts/`: lifecycle automation, service definitions, release utilities.
- `config/`: version, manifest, schedule, templates, payload content.
- `tests/`: operational and regression checks.

Do not cross-contaminate responsibilities across these roots.

## 6. Logging Standards

- Log with enough context to diagnose issues remotely.
- Include timestamps in persistent logs.
- For update/install/repair flows, log each major step start/end.
- Avoid logging secrets or sensitive environment values.

## 7. Error-Handling Standards

- Fail fast on unrecoverable preconditions.
- Retry transient network operations with bounded attempts.
- On update failures, preserve current running state whenever possible.
- Emit actionable failures (what failed, where, and likely next step).

## 8. Commenting Philosophy

- Comment intent and invariants, not obvious mechanics.
- Add comments for non-obvious safety rules and side-effect boundaries.
- Keep comments accurate; remove stale comments during refactors.

Examples:
- Good: explain why manifest excludes local config files.
- Avoid: repeating what a single-line assignment already states.
