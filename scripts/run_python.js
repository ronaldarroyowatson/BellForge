#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function pythonCommandCandidates() {
  const candidates = [];
  const windowsVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  const posixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');

  if (process.env.BELLFORGE_PYTHON) {
    candidates.push({ command: process.env.BELLFORGE_PYTHON, args: [] });
  }
  if (fs.existsSync(windowsVenv)) {
    candidates.push({ command: windowsVenv, args: [] });
  }
  if (fs.existsSync(posixVenv)) {
    candidates.push({ command: posixVenv, args: [] });
  }
  if (candidates.length > 0) {
    return candidates;
  }
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', args: ['-3'] });
  }
  candidates.push({ command: 'python3', args: [] });
  candidates.push({ command: 'python', args: [] });
  return candidates;
}

function runWithCandidate(candidate, args) {
  return spawnSync(candidate.command, [...candidate.args, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/run_python.js <python args...>');
    process.exit(2);
  }

  const candidates = pythonCommandCandidates();
  let lastError = null;
  for (const candidate of candidates) {
    const result = runWithCandidate(candidate, args);
    if (!result.error) {
      process.exit(result.status ?? 0);
    }
    lastError = result.error;
  }

  console.error(`Unable to locate a working Python interpreter for BellForge: ${lastError?.message || 'unknown error'}`);
  process.exit(1);
}

main();