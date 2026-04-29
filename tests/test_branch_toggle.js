const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'branch-toggle.sh');

function hasCommand(command) {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function findBash() {
  if (process.env.BELLFORGE_BASH && fs.existsSync(process.env.BELLFORGE_BASH)) {
    return process.env.BELLFORGE_BASH;
  }
  if (process.platform === 'win32') {
    const commonPaths = [
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files/Git/usr/bin/bash.exe',
    ];
    for (const candidate of commonPaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  return hasCommand('bash') ? 'bash' : null;
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

test('branch-toggle script includes required branch mappings and git sync commands', () => {
  const content = fs.readFileSync(SCRIPT_PATH, 'utf-8');
  assert.match(content, /cloud\)\s*\n\s*BRANCH="auth-fix-cloud"/);
  assert.match(content, /main\)\s*\n\s*BRANCH="main"/);
  assert.match(content, /git fetch --prune origin/);
  assert.match(content, /git checkout/);
  assert.match(content, /git pull --ff-only origin/);
  assert.match(content, /Uncommitted tracked changes detected/);
  assert.match(content, /Git lock file detected/);
});

test('branch-toggle switches between cloud and main when bash is available', { skip: !findBash() }, () => {
  const bash = findBash();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellforge-branch-toggle-'));
  const originRepo = path.join(tmpDir, 'origin.git');
  const seedRepo = path.join(tmpDir, 'seed');
  const workRepo = path.join(tmpDir, 'work');

  try {
    runGit(['init', '--bare', originRepo], REPO_ROOT);

    runGit(['init', seedRepo], REPO_ROOT);
    runGit(['config', 'user.name', 'BellForge Test'], seedRepo);
    runGit(['config', 'user.email', 'tests@bellforge.local'], seedRepo);
    runGit(['remote', 'add', 'origin', originRepo], seedRepo);

    fs.writeFileSync(path.join(seedRepo, 'state.txt'), 'main-v1\n', 'utf-8');
    runGit(['add', 'state.txt'], seedRepo);
    runGit(['commit', '-m', 'seed main'], seedRepo);
    runGit(['branch', '-M', 'main'], seedRepo);
    runGit(['push', '-u', 'origin', 'main'], seedRepo);

    runGit(['checkout', '-b', 'auth-fix-cloud'], seedRepo);
    fs.writeFileSync(path.join(seedRepo, 'state.txt'), 'cloud-v1\n', 'utf-8');
    runGit(['add', 'state.txt'], seedRepo);
    runGit(['commit', '-m', 'seed cloud'], seedRepo);
    runGit(['push', '-u', 'origin', 'auth-fix-cloud'], seedRepo);

    runGit(['clone', '--branch', 'main', originRepo, workRepo], REPO_ROOT);
    fs.copyFileSync(SCRIPT_PATH, path.join(workRepo, 'branch-toggle.sh'));

    const cloudRun = spawnSync(bash, ['./branch-toggle.sh', 'cloud'], {
      cwd: workRepo,
      encoding: 'utf-8',
    });
    assert.equal(cloudRun.status, 0, cloudRun.stderr || cloudRun.stdout);
    assert.equal(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workRepo), 'auth-fix-cloud');
    assert.equal(fs.readFileSync(path.join(workRepo, 'state.txt'), 'utf-8').trim(), 'cloud-v1');

    const mainRun = spawnSync(bash, ['./branch-toggle.sh', 'main'], {
      cwd: workRepo,
      encoding: 'utf-8',
    });
    assert.equal(mainRun.status, 0, mainRun.stderr || mainRun.stdout);
    assert.equal(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workRepo), 'main');
    assert.equal(fs.readFileSync(path.join(workRepo, 'state.txt'), 'utf-8').trim(), 'main-v1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
