#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { chromium } = require('playwright');

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'tests', 'logs', 'pi-rollout');
const DEFAULT_PI_HOST = '192.168.2.180';
const DEFAULT_PI_USER = 'pi';
const DEFAULT_HTTP_PORT = 8000;
const DEFAULT_REBOOT_DOWN_TIMEOUT_MS = 90_000;
const DEFAULT_REBOOT_UP_TIMEOUT_MS = 240_000;
const DEFAULT_STAGE_TIMEOUT_MS = 180_000;
const DEFAULT_APPLY_TIMEOUT_MS = 300_000;

function parseArgs(argv) {
  const parsed = {
    piHost: process.env.BELLFORGE_PI_HOST || DEFAULT_PI_HOST,
    piUser: process.env.BELLFORGE_PI_USER || DEFAULT_PI_USER,
    sshKeyPath: process.env.BELLFORGE_PI_SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'exportedRaspberryPiKey'),
    httpPort: Number(process.env.BELLFORGE_PI_HTTP_PORT || DEFAULT_HTTP_PORT),
    expectedVersion: process.env.BELLFORGE_EXPECTED_VERSION || readLocalVersion(),
    allowAlreadyCurrent: false,
    skipReboot: false,
    stageTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
    applyTimeoutMs: DEFAULT_APPLY_TIMEOUT_MS,
    rebootDownTimeoutMs: DEFAULT_REBOOT_DOWN_TIMEOUT_MS,
    rebootUpTimeoutMs: DEFAULT_REBOOT_UP_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--pi-host' && next) {
      parsed.piHost = next;
      index += 1;
    } else if (arg === '--pi-user' && next) {
      parsed.piUser = next;
      index += 1;
    } else if (arg === '--ssh-key' && next) {
      parsed.sshKeyPath = next;
      index += 1;
    } else if (arg === '--http-port' && next) {
      parsed.httpPort = Number(next);
      index += 1;
    } else if (arg === '--expected-version' && next) {
      parsed.expectedVersion = next;
      index += 1;
    } else if (arg === '--stage-timeout-ms' && next) {
      parsed.stageTimeoutMs = Number(next);
      index += 1;
    } else if (arg === '--apply-timeout-ms' && next) {
      parsed.applyTimeoutMs = Number(next);
      index += 1;
    } else if (arg === '--reboot-down-timeout-ms' && next) {
      parsed.rebootDownTimeoutMs = Number(next);
      index += 1;
    } else if (arg === '--reboot-up-timeout-ms' && next) {
      parsed.rebootUpTimeoutMs = Number(next);
      index += 1;
    } else if (arg === '--allow-already-current') {
      parsed.allowAlreadyCurrent = true;
    } else if (arg === '--skip-reboot') {
      parsed.skipReboot = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.baseUrl = `http://${parsed.piHost}:${parsed.httpPort}`;
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/verify_pi_bugfix_rollout.js [options]

Required behavior:
  - verifies the Pi detects the expected published version
  - verifies the update is downloaded and staged
  - reboots the Pi and waits for it to return
  - verifies the expected version is installed after reboot
  - verifies status, settings, and preview card pages through a real browser

Options:
  --pi-host <host>                  Pi host or IP (default: ${DEFAULT_PI_HOST})
  --pi-user <user>                  SSH user (default: ${DEFAULT_PI_USER})
  --ssh-key <path>                  SSH private key path
  --http-port <port>                BellForge HTTP port (default: ${DEFAULT_HTTP_PORT})
  --expected-version <version>      Release version to validate (default: local config/version.json)
  --allow-already-current           Allow audit-only reruns when the Pi is already on the expected version
  --skip-reboot                     Skip the reboot/apply cycle and only perform prechecks
  --stage-timeout-ms <ms>           Timeout while waiting for staged update evidence
  --apply-timeout-ms <ms>           Timeout while waiting for post-reboot apply completion
  --reboot-down-timeout-ms <ms>     Timeout while waiting for the Pi to go offline during reboot
  --reboot-up-timeout-ms <ms>       Timeout while waiting for the Pi to come back after reboot
`);
}

function readLocalVersion() {
  const versionPath = path.join(REPO_ROOT, 'config', 'version.json');
  const payload = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  return payload.version;
}

function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function writeJsonArtifact(name, payload) {
  ensureArtifactDir();
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${name}.json`), JSON.stringify(payload, null, 2));
}

function logStep(message) {
  console.log(`[rollout] ${message}`);
}

function sshArgs(config) {
  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(os.homedir(), '.ssh', 'known_hosts')}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=12',
    '-i', config.sshKeyPath,
  ];
}

async function runCommand(command, args, options = {}) {
  const timeout = options.timeoutMs || 30_000;
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd || REPO_ROOT,
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === 'number' ? error.code : null,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
      error: error.message || String(error),
    };
  }
}

async function runSsh(config, remoteCommand, options = {}) {
  const host = `${config.piUser}@${config.piHost}`;
  return runCommand('ssh', [...sshArgs(config), host, remoteCommand], options);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 10_000),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${bodyText}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${bodyText}`);
  }
}

async function canReachHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function canReachSsh(config) {
  const result = await runSsh(config, 'true', { timeoutMs: 12_000 });
  return result.ok;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, options = {}) {
  const timeoutMs = options.timeoutMs || 60_000;
  const intervalMs = options.intervalMs || 5_000;
  const startedAt = Date.now();
  let lastValue = null;

  while (Date.now() - startedAt <= timeoutMs) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function collectApiState(config, label) {
  const updater = await fetchJson(`${config.baseUrl}/api/updater/status`, { timeoutMs: 15_000 });
  const display = await fetchJson(`${config.baseUrl}/api/display/pipeline`, { timeoutMs: 15_000 });
  const version = await fetchJson(`${config.baseUrl}/api/version`, { timeoutMs: 15_000 });
  const snapshot = { label, updater, display, version };
  writeJsonArtifact(label, snapshot);
  return snapshot;
}

async function captureRemoteTriage(config, label) {
  const result = await runSsh(config, 'python3 /opt/bellforge/scripts/bellforge_cli.py triage --host-label live-pi', { timeoutMs: 60_000 });
  const payload = {
    label,
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  writeJsonArtifact(label, payload);
  return payload;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForLayoutReady(target) {
  await target.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('[data-fibo-card]'));
    return cards.length > 0 && cards.every((card) => Number(card.dataset.fiboColSpan || 0) >= 1 && Number(card.dataset.fiboRowSpan || 0) >= 1);
  }, { timeout: 20_000 });
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function captureGridSnapshot(target, label) {
  const snapshot = await target.evaluate((artifactLabel) => {
    const round = (value) => Math.round(value * 100) / 100;
    const cards = Array.from(document.querySelectorAll('[data-fibo-card]')).map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        key: card.dataset.cardKey,
        order: Number(card.dataset.fiboOrder || 0),
        rowIndex: Number(card.dataset.fiboRowIndex || 0),
        colStart: Number(card.dataset.fiboColStart || 0),
        colSpan: Number(card.dataset.fiboColSpan || 0),
        rowStart: Number(card.dataset.fiboRowStart || 0),
        rowSpan: Number(card.dataset.fiboRowSpan || 0),
        collapsed: card.classList.contains('is-collapsed'),
        rect: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          right: round(rect.right),
          bottom: round(rect.bottom),
        },
      };
    }).sort((left, right) => left.order - right.order);
    return {
      label: artifactLabel,
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cards,
    };
  }, label);
  writeJsonArtifact(label, snapshot);
  return snapshot;
}

function assertNoOverlap(snapshot) {
  const cards = snapshot.cards;
  assertCondition(cards.length > 0, `${snapshot.label}: no fibo cards found`);
  for (let index = 0; index < cards.length; index += 1) {
    for (let compare = index + 1; compare < cards.length; compare += 1) {
      const left = cards[index].rect;
      const right = cards[compare].rect;
      const overlaps = !(left.bottom <= right.y + 1 || right.bottom <= left.y + 1 || left.right <= right.x + 1 || right.right <= left.x + 1);
      assertCondition(!overlaps, `${snapshot.label}: ${cards[index].key} overlaps ${cards[compare].key}`);
    }
  }
}

async function waitForText(page, selector, expectedText) {
  await page.waitForFunction(
    ({ targetSelector, targetText }) => {
      const element = document.querySelector(targetSelector);
      return element && element.textContent && element.textContent.trim() === targetText;
    },
    { targetSelector: selector, targetText: expectedText },
    { timeout: 20_000 },
  );
}

async function verifyStatusPage(context, config, expectedVersion, artifactPrefix) {
  const page = await context.newPage();
  const consoleEntries = [];
  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text() }));
  await page.goto(`${config.baseUrl}/status`, { waitUntil: 'domcontentloaded' });
  await waitForLayoutReady(page);
  await waitForText(page, '#versionValue', expectedVersion);

  const snapshot = await captureGridSnapshot(page, `${artifactPrefix}-status-grid`);
  assertNoOverlap(snapshot);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `${artifactPrefix}-status.png`), fullPage: true });
  writeJsonArtifact(`${artifactPrefix}-status-console`, consoleEntries);
  await page.close();
  return snapshot;
}

async function verifySettingsPage(context, config, expectedBrowserVersion, expectedPreviewVersion, artifactPrefix) {
  const page = await context.newPage();
  const consoleEntries = [];
  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text() }));
  await page.goto(`${config.baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
  await waitForLayoutReady(page);
  await waitForText(page, '#currentVersion', expectedBrowserVersion);
  await waitForText(page, '#latestVersion', expectedBrowserVersion);

  const snapshot = await captureGridSnapshot(page, `${artifactPrefix}-settings-grid`);
  assertNoOverlap(snapshot);

  await page.click('#designStatusPreviewToggle');
  await page.waitForSelector('#designStatusPreviewModal:not([hidden])', { timeout: 10_000 });
  const frameHandle = await page.waitForSelector('#designStatusMirror', { timeout: 10_000 });
  const frame = await frameHandle.contentFrame();
  assertCondition(!!frame, `${artifactPrefix}: status preview iframe did not load`);
  await waitForLayoutReady(frame);
  await waitForText(frame, '#versionValue', expectedPreviewVersion);
  const previewSnapshot = await captureGridSnapshot(frame, `${artifactPrefix}-preview-grid`);
  assertNoOverlap(previewSnapshot);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `${artifactPrefix}-settings.png`), fullPage: true });
  await page.click('#designStatusModalClose');
  writeJsonArtifact(`${artifactPrefix}-settings-console`, consoleEntries);
  await page.close();
  return { settings: snapshot, preview: previewSnapshot };
}

async function verifyBrowserSurface(config, phase, expectedBrowserVersion) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    const status = await verifyStatusPage(context, config, expectedBrowserVersion, `${phase}`);
    const settings = await verifySettingsPage(context, config, expectedBrowserVersion, expectedBrowserVersion, `${phase}`);
    return { status, settings };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function triggerCheckNow(config) {
  return fetchJson(`${config.baseUrl}/api/updater/check-now`, {
    method: 'POST',
    body: {},
    timeoutMs: 20_000,
  });
}

async function rebootPi(config) {
  const result = await runSsh(config, 'sudo systemctl reboot', { timeoutMs: 20_000 });
  writeJsonArtifact('reboot-command', result);
  return result;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  ensureArtifactDir();

  const summary = {
    startedAt: new Date().toISOString(),
    config: {
      piHost: config.piHost,
      piUser: config.piUser,
      baseUrl: config.baseUrl,
      expectedVersion: config.expectedVersion,
      allowAlreadyCurrent: config.allowAlreadyCurrent,
      skipReboot: config.skipReboot,
    },
    steps: [],
  };

  const recordStep = (name, payload) => {
    summary.steps.push({ name, timestamp: new Date().toISOString(), ...payload });
    writeJsonArtifact('summary', summary);
  };

  try {
    logStep(`collecting pre-rollout state for ${config.baseUrl}`);
    const preState = await collectApiState(config, 'pre-rollout-api-state');
    await captureRemoteTriage(config, 'pre-rollout-triage');
    recordStep('pre-rollout-state', {
      updaterState: preState.updater.state,
      currentVersion: preState.updater.current_device_version,
      latestDetectedVersion: preState.updater.latest_detected_version,
      stagedReleaseVersion: preState.updater.staged_release_version,
    });

    assertCondition(preState.version.version === preState.updater.current_device_version, 'Pi /api/version does not match updater current_device_version');
    assertCondition(preState.updater.latest_detected_version === config.expectedVersion, `Pi did not detect expected version ${config.expectedVersion}`);

    await verifyBrowserSurface(config, 'pre-rollout-browser', config.expectedVersion);
    recordStep('pre-rollout-browser-ok', {
      currentVersion: preState.updater.current_device_version,
      latestDetectedVersion: config.expectedVersion,
    });

    const alreadyCurrent = preState.updater.current_device_version === config.expectedVersion && !preState.updater.staged_update_pending;
    if (alreadyCurrent) {
      assertCondition(config.allowAlreadyCurrent, `Pi is already on ${config.expectedVersion}; rerun with --allow-already-current only for audit-only validation`);
      recordStep('already-current', { message: 'Pi was already on the expected version before manual rollout validation.' });
      summary.finishedAt = new Date().toISOString();
      writeJsonArtifact('summary', summary);
      return;
    }

    if (!preState.updater.staged_update_pending || preState.updater.staged_release_version !== config.expectedVersion) {
      logStep(`triggering check-now to stage ${config.expectedVersion}`);
      const triggerResponse = await triggerCheckNow(config);
      writeJsonArtifact('check-now-response', triggerResponse);
      recordStep('check-now-triggered', { accepted: !!triggerResponse.accepted, message: triggerResponse.message });
    } else {
      recordStep('check-now-skipped', { message: `Pi already has ${config.expectedVersion} staged.` });
    }

    const stagedState = await waitFor(
      `staged update ${config.expectedVersion}`,
      async () => {
        const state = await collectApiState(config, 'staged-rollout-api-state');
        if (state.updater.staged_update_pending && state.updater.staged_release_version === config.expectedVersion) {
          return state;
        }
        return null;
      },
      { timeoutMs: config.stageTimeoutMs, intervalMs: 5_000 },
    );
    recordStep('staged-update-confirmed', {
      state: stagedState.updater.state,
      stagedReleaseVersion: stagedState.updater.staged_release_version,
      downloadProgress: stagedState.updater.download_progress,
    });

    assertCondition(stagedState.updater.download_progress.percent >= 100, 'Pi has not fully downloaded the staged release');

    await verifyBrowserSurface(config, 'staged-rollout-browser', config.expectedVersion);
    recordStep('staged-browser-ok', {
      currentVersion: stagedState.updater.current_device_version,
      latestDetectedVersion: config.expectedVersion,
    });

    if (config.skipReboot) {
      summary.finishedAt = new Date().toISOString();
      writeJsonArtifact('summary', summary);
      return;
    }

    logStep('rebooting Pi to apply the staged release');
    await rebootPi(config);
    recordStep('reboot-issued', {});

    await waitFor('Pi SSH shutdown', async () => {
      const alive = await canReachSsh(config);
      return alive ? null : { down: true };
    }, { timeoutMs: config.rebootDownTimeoutMs, intervalMs: 5_000 });
    recordStep('reboot-down-confirmed', {});

    await waitFor('Pi SSH recovery', async () => {
      const alive = await canReachSsh(config);
      return alive ? { up: true } : null;
    }, { timeoutMs: config.rebootUpTimeoutMs, intervalMs: 10_000 });
    recordStep('reboot-ssh-up', {});

    await waitFor('Pi HTTP recovery', async () => {
      const healthy = await canReachHealth(config.baseUrl);
      return healthy ? { healthy: true } : null;
    }, { timeoutMs: config.rebootUpTimeoutMs, intervalMs: 5_000 });
    recordStep('reboot-http-up', {});

    const appliedState = await waitFor(
      `installed version ${config.expectedVersion}`,
      async () => {
        const state = await collectApiState(config, 'post-rollout-api-state');
        if (
          state.updater.current_device_version === config.expectedVersion
          && state.version.version === config.expectedVersion
          && !state.updater.staged_update_pending
        ) {
          return state;
        }
        return null;
      },
      { timeoutMs: config.applyTimeoutMs, intervalMs: 5_000 },
    );
    recordStep('post-reboot-apply-confirmed', {
      state: appliedState.updater.state,
      currentVersion: appliedState.updater.current_device_version,
      latestDetectedVersion: appliedState.updater.latest_detected_version,
      lastUpdateResult: appliedState.updater.last_update_result,
    });

    await captureRemoteTriage(config, 'post-rollout-triage');
    await verifyBrowserSurface(config, 'post-rollout-browser', config.expectedVersion);
    recordStep('post-rollout-browser-ok', {
      currentVersion: config.expectedVersion,
      latestDetectedVersion: config.expectedVersion,
    });

    summary.finishedAt = new Date().toISOString();
    writeJsonArtifact('summary', summary);
    logStep(`Pi rollout verification succeeded for ${config.expectedVersion}`);
  } catch (error) {
    summary.finishedAt = new Date().toISOString();
    summary.error = { message: error.message, stack: error.stack };
    writeJsonArtifact('summary', summary);
    console.error(`[rollout] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

main();