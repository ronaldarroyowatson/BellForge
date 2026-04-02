#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const args = process.argv.slice(2);

function resolvePython() {
  const envOverride = process.env.BELLFORGE_PYTHON;
  if (envOverride && envOverride.trim().length > 0) return envOverride;

  if (platform() === "win32") {
    if (existsSync(".venv/Scripts/python.exe")) return ".venv/Scripts/python.exe";
    return "python";
  }

  if (existsSync(".venv/bin/python")) return ".venv/bin/python";
  return "python3";
}

const pythonExe = resolvePython();
const cmdArgs = ["tests/run_auth_suite.py", ...args];

const result = spawnSync(pythonExe, cmdArgs, {
  stdio: "inherit",
  shell: false,
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
