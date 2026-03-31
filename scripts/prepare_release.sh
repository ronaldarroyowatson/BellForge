#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${REPO_ROOT}/tests/logs"
PREP_LOG="${LOG_DIR}/prepare_release.log"
mkdir -p "${LOG_DIR}"
exec > >(tee "${PREP_LOG}") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
print_ok() { echo -e "${GREEN}[PASS]${NC} $*"; }
print_fail() { echo -e "${RED}[FAIL]${NC} $*"; }

bail() {
  print_fail "$*"
  print_warn "See logs in ${LOG_DIR}"
  exit 1
}

validate_no_untracked() {
  local untracked
  untracked="$(git -C "${REPO_ROOT}" ls-files --others --exclude-standard)"
  if [[ -n "${untracked}" ]]; then
    echo "${untracked}"
    bail "Untracked files detected. Clean or commit before release prep."
  fi
}

parse_version() {
  python3 - "$1" <<'PY'
import json
from pathlib import Path
v = json.loads(Path("config/version.json").read_text(encoding="utf-8")).get("version", "0.0.0")
print(v)
PY
}

compare_versions() {
  python3 - "$1" "$2" <<'PY'
import sys

def parse(v: str):
    try:
        a,b,c=v.strip().split('.')
        return (int(a), int(b), int(c))
    except Exception:
        return (0,0,0)

old_v, new_v = sys.argv[1], sys.argv[2]
if parse(new_v) <= parse(old_v):
    raise SystemExit(1)
PY
}

validate_manifest_integrity() {
  python3 - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path('.')
manifest = json.loads((root / 'config/manifest.json').read_text(encoding='utf-8'))
files = manifest.get('files', {})
if not isinstance(files, dict) or not files:
    raise SystemExit('manifest.json has no files map')

for rel_path, meta in files.items():
    target = root / rel_path
    if not target.is_file():
        raise SystemExit(f'manifest references missing file: {rel_path}')
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != meta.get('sha256', ''):
        raise SystemExit(f'hash mismatch in manifest for {rel_path}')

print(f'manifest validated ({len(files)} files)')
PY
}

validate_update_download_package() {
  local port="18081"
  pushd "${REPO_ROOT}" >/dev/null
  python3 -m http.server "${port}" >/tmp/bellforge-release-http.log 2>&1 &
  local server_pid="$!"
  popd >/dev/null
  sleep 1

  trap 'kill ${server_pid} 2>/dev/null || true' RETURN

  python3 - <<'PY'
import json
import urllib.request
from pathlib import Path

base = 'http://127.0.0.1:18081'
manifest = json.loads(Path('config/manifest.json').read_text(encoding='utf-8'))
for rel_path in manifest.get('files', {}):
    with urllib.request.urlopen(f"{base}/{rel_path}", timeout=20) as resp:
        if resp.status != 200:
            raise SystemExit(f'download failed: {rel_path}')
print('all manifest files downloadable')
PY

  kill "${server_pid}" 2>/dev/null || true
  trap - RETURN
}

main() {
  print_info "Starting BellForge prepare_release workflow"
  validate_no_untracked

  print_info "Running full test suite"
  bash "${REPO_ROOT}/tests/run_all_tests.sh" || bail "Test suite failed"
  print_ok "Full test suite passed"

  print_info "Regenerating manifest"
  (cd "${REPO_ROOT}" && python3 scripts/generate_manifest.py)

  local old_version new_version
  old_version="$(cd "${REPO_ROOT}" && python3 -c "import json; print(json.load(open('config/version.json'))['version'])")"

  print_info "Bumping patch version"
  (cd "${REPO_ROOT}" && python3 scripts/bump_version.py patch)

  new_version="$(cd "${REPO_ROOT}" && python3 -c "import json; print(json.load(open('config/version.json'))['version'])")"
  if ! compare_versions "${old_version}" "${new_version}"; then
    bail "Version did not increment properly (${old_version} -> ${new_version})"
  fi

  print_info "Validating manifest integrity and update payload completeness"
  (cd "${REPO_ROOT}" && validate_manifest_integrity)
  (cd "${REPO_ROOT}" && validate_update_download_package)
  print_ok "Autoupdate package validated"

  print_info "Ensuring repo is clean after generated updates"
  validate_no_untracked

  local tag_name="v${new_version}"
  if git -C "${REPO_ROOT}" rev-parse "${tag_name}" >/dev/null 2>&1; then
    bail "Tag ${tag_name} already exists"
  fi

  git -C "${REPO_ROOT}" add config/version.json config/manifest.json
  git -C "${REPO_ROOT}" commit -m "chore: release ${tag_name}"
  git -C "${REPO_ROOT}" tag "${tag_name}"

  print_ok "Release prepared successfully"
  echo
  echo "Run the following commands to push safely:"
  echo "  git push origin HEAD"
  echo "  git push origin ${tag_name}"
}

main "$@"
