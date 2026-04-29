# Branch Switching (GUI + CLI, No Sudo)

This workflow lets BellForge developers and Raspberry Pi operators switch between:
- `auth-fix-cloud` (alias: `cloud`)
- `main`

All commands run as the current user. No `sudo` is required.

## What Was Added

- `branch-toggle.sh` in the repo root:
  - accepts `cloud` or `main`
  - runs `git fetch --prune`, `git checkout`, and `git pull --ff-only`
  - prints active branch and commit at the end
  - blocks branch changes when tracked files are dirty
  - detects `.git/index.lock` and exits safely
  - sets local `core.fileMode=false` to reduce permission-bit churn on Pi/Linux

- VS Code task entries in `.vscode/tasks.json`:
  - `Switch Branch → Cloud Auth Fix`
  - `Switch Branch → Main`

## CLI Usage

From the BellForge repo root:

```bash
bash ./branch-toggle.sh cloud
bash ./branch-toggle.sh main
```

Expected result:
- latest refs fetched from origin
- selected branch checked out
- branch fast-forwarded to latest remote commit
- printed confirmation of active branch + commit

## VS Code GUI Usage

### Command Palette

1. Open Command Palette (`Ctrl+Shift+P`).
2. Run `Tasks: Run Task`.
3. Choose one:
   - `Switch Branch → Cloud Auth Fix`
   - `Switch Branch → Main`

### Source Control Panel

1. Open Source Control (`Ctrl+Shift+G`).
2. Open the panel menu (`...`).
3. Choose `Tasks: Run Task`.
4. Select one of the branch-switch tasks above.

This keeps branch switching visible from the Source Control workflow, not only from terminal usage.

## Pi Sync Behavior After Merges

- For whichever branch you select, the script always does:
  1. `git fetch --prune origin`
  2. `git checkout <branch>`
  3. `git pull --ff-only origin <branch>`

That ensures the Pi repo is synced to cloud state without creating merge commits.

## Safety Notes

- No file ownership changes are performed.
- No chmod/chown operations are run.
- No elevated privileges are used.
- If tracked changes exist while switching branches, the script exits with a clear message.
- If a stale git lock exists, the script exits before any write operation.
