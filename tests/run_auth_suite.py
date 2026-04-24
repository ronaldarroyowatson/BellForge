#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

AUTH_TEST_FILES = [
    "tests/test_unified_auth_unit.py",
    "tests/test_unified_auth_integration.py",
    "tests/test_unified_auth_e2e.py",
    "tests/test_unified_auth_local_unit.py",
    "tests/test_unified_auth_local_integration.py",
    "tests/test_dev_admin_local_auth.py",
]
COVERAGE_FAIL_UNDER = 79
COVERAGE_INCLUDE = "backend/services/unified_auth.py,backend/routes/auth_api.py,backend/routes/devices.py"


@dataclass
class TestResult:
    test_file: str
    exit_code: int
    duration_seconds: float
    output: str


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def _run_single(test_file: str) -> TestResult:
    start = time.perf_counter()
    proc = _run([sys.executable, "-m", "unittest", test_file])
    elapsed = time.perf_counter() - start
    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    return TestResult(test_file=test_file, exit_code=proc.returncode, duration_seconds=elapsed, output=output.strip())


def _run_parallel(test_files: list[str]) -> list[TestResult]:
    results: list[TestResult] = []
    with ThreadPoolExecutor(max_workers=min(4, len(test_files))) as executor:
        futures = {executor.submit(_run_single, file): file for file in test_files}
        for future in as_completed(futures):
            results.append(future.result())
    return sorted(results, key=lambda r: r.test_file)


def _run_sequential(test_files: list[str], fail_fast: bool) -> list[TestResult]:
    results: list[TestResult] = []
    for test_file in test_files:
        result = _run_single(test_file)
        results.append(result)
        if fail_fast and result.exit_code != 0:
            break
    return results


def _run_with_coverage(test_files: list[str]) -> tuple[int, str]:
    erase = _run([sys.executable, "-m", "coverage", "erase"])
    if erase.returncode != 0:
        return erase.returncode, (erase.stdout or "") + (erase.stderr or "")

    run_cmd = [sys.executable, "-m", "coverage", "run", "--branch", "-m", "unittest", *test_files]
    ran = _run(run_cmd)
    if ran.returncode != 0:
        return ran.returncode, (ran.stdout or "") + (ran.stderr or "")

    report_cmd = [
        sys.executable,
        "-m",
        "coverage",
        "report",
        f"--fail-under={COVERAGE_FAIL_UNDER}",
        f"--include={COVERAGE_INCLUDE}",
    ]
    report = _run(report_cmd)
    combined = "\n".join(part for part in [ran.stdout, ran.stderr, report.stdout, report.stderr] if part)
    return report.returncode, combined


def main() -> int:
    parser = argparse.ArgumentParser(description="Run BellForge authentication test suite.")
    parser.add_argument("--parallel", action="store_true", help="Run test files in parallel.")
    parser.add_argument("--coverage", action="store_true", help="Run with coverage threshold enforcement.")
    parser.add_argument("--fail-fast", action="store_true", help="Stop on first test failure in sequential mode.")
    args = parser.parse_args()

    missing = [path for path in AUTH_TEST_FILES if not Path(path).is_file()]
    if missing:
        print(json.dumps({"ok": False, "error": "missing_test_files", "files": missing}, indent=2))
        return 2

    if args.coverage:
        code, output = _run_with_coverage(AUTH_TEST_FILES)
        print(json.dumps({"suite": "auth", "mode": "coverage", "ok": code == 0}, indent=2))
        if output.strip():
            print(output)
        return code

    results = _run_parallel(AUTH_TEST_FILES) if args.parallel else _run_sequential(AUTH_TEST_FILES, args.fail_fast)
    failed = [r for r in results if r.exit_code != 0]

    print(
        json.dumps(
            {
                "suite": "auth",
                "mode": "parallel" if args.parallel else "sequential",
                "ok": len(failed) == 0,
                "results": [
                    {
                        "test_file": r.test_file,
                        "exit_code": r.exit_code,
                        "duration_seconds": round(r.duration_seconds, 3),
                    }
                    for r in results
                ],
            },
            indent=2,
        )
    )

    if failed:
        for fail in failed:
            print(f"\n--- FAILURE: {fail.test_file} ---")
            print(fail.output)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
