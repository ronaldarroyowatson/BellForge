const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const { chromium } = require('playwright');
const {
  collectOverlaps,
  collectSpacingMetrics,
  countVisibleCards,
  findFibonacciRatioIssues,
  findWeightOrderingIssues,
  simplifyLayout,
} = require('./layout_dom_utils.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATUS_PATH = '/status';
const SETTINGS_PATH = '/settings';
const DISPLAY_STATUS_PATH = '/status?view=display';
const STATUS_LAYOUT_FILE = path.join(REPO_ROOT, 'config', 'status_layout.json');
const TEST_CONTROL_SERVER_STATE_FILE = path.join(REPO_ROOT, 'tests', 'logs', 'layout-browser', 'test_control_server_state.json');
const BROWSER_LOG_DIR = path.join(REPO_ROOT, 'tests', 'logs', 'layout-browser');
const STORAGE_KEYS = [
  'bellforge.status.fibo-cards.v1',
  'bellforge.status.layout-settings.v1',
  'bellforge.settings.fibo-cards.v1',
  'bellforge.status.layout-command.v1',
  'bellforge.design-controls.live.v1',
  'bellforge.debug.fibo',
  'bellforge.debug.verbose',
];
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_TEXT = 1000;

let backendProcess = null;
let startedBackend = false;
let artifactSequence = 0;
const PREFERRED_BACKEND_PORT = process.env.BELLFORGE_TEST_PORT
  ? Number.parseInt(process.env.BELLFORGE_TEST_PORT, 10)
  : 0;
let backendPort = PREFERRED_BACKEND_PORT;
let BASE_URL = `http://127.0.0.1:${backendPort}`;
let exitScheduled = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLabel(value) {
  return String(value || 'artifact').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase();
}

function writeArtifact(label, payload) {
  fs.mkdirSync(BROWSER_LOG_DIR, { recursive: true });
  artifactSequence += 1;
  const fileName = `${String(artifactSequence).padStart(2, '0')}-${sanitizeLabel(label)}.json`;
  fs.writeFileSync(path.join(BROWSER_LOG_DIR, fileName), JSON.stringify(payload, null, 2));
}

function resetSharedStatusLayout() {
  try {
    fs.unlinkSync(STATUS_LAYOUT_FILE);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function recordSnapshotArtifact(label, snapshot, consoleEntries = [], extras = {}) {
  writeArtifact(label, {
    snapshot,
    spacing: collectSpacingMetrics(snapshot),
    overlaps: collectOverlaps(snapshot),
    consoleEntries,
    ...extras,
  });
}

function buildBaseUrl(port = backendPort) {
  return `http://127.0.0.1:${port}`;
}

function isServerHealthy(port = backendPort) {
  return new Promise((resolve) => {
    const request = http.get(`${buildBaseUrl(port)}/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function reservePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' && preferredPort !== 0) {
        resolve(reservePort(0));
        return;
      }
      reject(error);
    });
    server.listen(preferredPort, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : preferredPort;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

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

async function ensureBackend() {
  if (startedBackend && await isServerHealthy(backendPort)) {
    return;
  }

  const startupPort = await reservePort(PREFERRED_BACKEND_PORT);
  backendPort = startupPort;
  BASE_URL = buildBaseUrl(startupPort);

  // Write a temporary UNCONFIGURED control server state so the test backend
  // allows unauthenticated layout saves (can_edit_layout returns True for UNCONFIGURED).
  fs.mkdirSync(path.dirname(TEST_CONTROL_SERVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(TEST_CONTROL_SERVER_STATE_FILE, JSON.stringify({ role: 'unconfigured' }), 'utf8');

  for (let pass = 0; pass < 3; pass += 1) {
    for (const candidate of pythonCommandCandidates()) {
      try {
        backendProcess = spawn(candidate.command, [
          ...candidate.args,
          '-m',
          'uvicorn',
          'backend.main:app',
          '--host',
          '127.0.0.1',
          '--port',
          String(startupPort),
          '--log-level',
          'warning',
        ], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            BELLFORGE_CONTROL_SERVER_STATE_PATH: TEST_CONTROL_SERVER_STATE_FILE,
          },
        });

        let stderr = '';
        let stdout = '';
        backendProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        backendProcess.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          if (await isServerHealthy(startupPort)) {
            startedBackend = true;
            return;
          }
          if (backendProcess.exitCode != null) {
            break;
          }
          await sleep(750);
        }

        if (await isServerHealthy(startupPort)) {
          startedBackend = true;
          return;
        }

        if (backendProcess.exitCode == null) {
          backendProcess.kill('SIGTERM');
        }
        backendProcess = null;
        writeArtifact('browser-backend-start-failure', {
          candidate,
          pass,
          stdout,
          stderr,
        });
      } catch {
        backendProcess = null;
      }
    }

    if (await isServerHealthy(startupPort)) {
      startedBackend = true;
      return;
    }
    await sleep(1500);
  }

  throw new Error(`Unable to start or reuse BellForge backend on ${BASE_URL}`);
}

async function stopBackend() {
  if (backendProcess && startedBackend && backendProcess.exitCode == null) {
    backendProcess.kill('SIGTERM');
    await sleep(2000);
    if (backendProcess.exitCode == null) {
      backendProcess.kill('SIGKILL');
      await sleep(500);
    }
  }
  backendProcess = null;
  startedBackend = false;
  backendPort = PREFERRED_BACKEND_PORT;
  BASE_URL = buildBaseUrl(backendPort);
}

after(async () => {
  await stopBackend();
  if (exitScheduled) {
    return;
  }
  exitScheduled = true;
  setImmediate(() => {
    process.exit(process.exitCode ?? 0);
  });
});

function attachConsole(target, label) {
  const entries = [];
  target.on('console', async (message) => {
    const text = String(message.text() || '').slice(0, MAX_CONSOLE_TEXT);
    entries.push({
      label,
      type: message.type(),
      text,
    });
    if (entries.length > MAX_CONSOLE_ENTRIES) {
      entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
    }
  });
  return entries;
}

async function waitForAnimationFrame(target) {
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForLayoutReady(target, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  await target.waitForFunction((allowEmptyCards) => {
    const cards = Array.from(document.querySelectorAll('[data-fibo-card]'));
    if (allowEmptyCards && cards.length === 0) {
      return true;
    }
    if (cards.length === 0) {
      return false;
    }

    const layoutHandle = window.__bellforgeStatusLayout || window.__bellforgeSettingsLayout || null;
    const layoutCache = layoutHandle?.getLayoutCache?.() || null;
    const container = document.querySelector('.fibo-adaptive-grid');
    const computedColumns = Number(
      getComputedStyle(container || document.documentElement).getPropertyValue('--fibo-columns')
      || container?.style?.getPropertyValue('--fibo-columns')
      || 0
    );
    const assignedCards = cards.filter((card) => Number(card.dataset.fiboColSpan || 0) >= 1 && Number(card.dataset.fiboRowSpan || 0) >= 1).length;

    return computedColumns >= 1
      || Number(layoutCache?.columns || 0) >= 1
      || assignedCards >= Math.min(cards.length, 2);
  }, allowEmpty);
  await waitForAnimationFrame(target);
}

function registerBrowserSuite() {
  return {
    async newContext(viewport = DEFAULT_VIEWPORT) {
      await ensureBackend();
      resetSharedStatusLayout();
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport });
      context.setDefaultTimeout(90000);
      const originalClose = context.close.bind(context);
      let closed = false;

      context.close = async (...args) => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await originalClose(...args);
        } finally {
          await browser.close();
          await stopBackend();
        }
      };

      await context.addInitScript((keys) => {
        keys.forEach((key) => localStorage.removeItem(key));
        localStorage.setItem('bellforge.debug.fibo', 'true');
        localStorage.setItem('bellforge.debug.verbose', 'false');
      }, STORAGE_KEYS);
      return context;
    },
  };
}

async function openPage(context, targetPath, label, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await context.newPage();
    const consoleEntries = attachConsole(page, label);
    try {
      await ensureBackend();
      await page.goto(`${BASE_URL}${targetPath}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForLayoutReady(page, options);
      return { page, consoleEntries };
    } catch (error) {
      lastError = error;
      await page.close().catch(() => {});
      await stopBackend();
      await ensureBackend();
    }
  }
  throw lastError;
}

async function clickElement(page, selector) {
  await page.click(selector);
  await waitForAnimationFrame(page);
}

async function openSettingsDisplayPage(settingsPage) {
  const displayPage = await settingsPage.context().newPage();
  await displayPage.goto(`${BASE_URL}${DISPLAY_STATUS_PATH}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForLayoutReady(displayPage);
  return displayPage.mainFrame();
}

async function broadcastStatusLayoutCommand(page, commandType, payload = {}) {
  await page.evaluate(({ commandType, payload }) => {
    localStorage.setItem('bellforge.status.layout-command.v1', JSON.stringify({
      source: 'browser-dom-verification',
      timestamp: Date.now(),
      type: commandType,
      payload,
    }));
  }, { commandType, payload });
  await waitForAnimationFrame(page);
}

async function openRealSurfaces(suite, viewport = DEFAULT_VIEWPORT, labelPrefix = 'layout') {
  const context = await suite.newContext(viewport);
  const status = await openPage(context, STATUS_PATH, `${labelPrefix}-status`);
  const display = await openPage(context, DISPLAY_STATUS_PATH, `${labelPrefix}-display`);
  const settings = await openPage(context, SETTINGS_PATH, `${labelPrefix}-settings`);
  const settingsDisplayPage = await openSettingsDisplayPage(settings.page);
  const settingsDisplayConsole = attachConsole(settingsDisplayPage.page(), `${labelPrefix}-settings-display`);
  await Promise.all([
    waitForLayoutReady(status.page),
    waitForLayoutReady(display.page),
    waitForLayoutReady(settings.page),
    waitForLayoutReady(settingsDisplayPage),
  ]);
  return {
    context,
    statusPage: status.page,
    statusConsole: status.consoleEntries,
    displayPage: display.page,
    displayConsole: display.consoleEntries,
    settingsPage: settings.page,
    settingsConsole: settings.consoleEntries,
    settingsDisplayPage,
    settingsDisplayConsole,
  };
}

async function resetPageLayout(page, kind) {
  await page.evaluate(({ kind, storageKeys }) => {
    storageKeys.forEach((key) => localStorage.removeItem(key));
    localStorage.setItem('bellforge.debug.fibo', 'true');
    if (kind === 'status' || kind === 'status-display') {
      window.__bellforgeStatusLayout?.resetState();
      window.__bellforgeStatusLayout?.autoArrange();
    }
    if (kind === 'settings') {
      window.__bellforgeSettingsLayout?.resetState();
      window.__bellforgeSettingsLayout?.autoArrange();
    }
  }, { kind, storageKeys: STORAGE_KEYS });
  await waitForLayoutReady(page);
}

async function withRepair(page, kind, label, runVerification) {
  try {
    return await runVerification('initial');
  } catch (error) {
    writeArtifact(`${label}-regression-initial`, {
      label,
      kind,
      error: { message: error.message, stack: error.stack },
    });
    await resetPageLayout(page, kind);
    try {
      return await runVerification('repaired');
    } catch (retryError) {
      writeArtifact(`${label}-regression-retry`, {
        label,
        kind,
        error: { message: retryError.message, stack: retryError.stack },
      });
      throw retryError;
    }
  }
}

async function captureSnapshot(target, kind) {
  return target.evaluate(async ({ kind }) => {
    const round = (value) => Math.round(value * 100) / 100;
    let debugInspector = null;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), 2000)
        : null;
      const response = await fetch('/api/debug/inspect?lines=120', {
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (timeoutId != null) {
        clearTimeout(timeoutId);
      }
      if (response.ok) {
        debugInspector = await response.json();
      }
    } catch {
      debugInspector = null;
    }
    const cards = Array.from(document.querySelectorAll('[data-fibo-card]')).map((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const titlebar = card.querySelector('.card-titlebar');
      const content = card.querySelector('.card-content');
      return {
        key: card.dataset.cardKey,
        tagName: card.tagName.toLowerCase(),
        className: card.className,
        collapsed: card.classList.contains('is-collapsed'),
        rowIndex: Number(card.dataset.fiboRowIndex || 0),
        rowStart: Number(card.dataset.fiboRowStart || 0),
        colStart: Number(card.dataset.fiboColStart || 0),
        colSpan: Number(card.dataset.fiboColSpan || 0),
        rowSpan: Number(card.dataset.fiboRowSpan || 0),
        order: Number(card.dataset.fiboOrder || 0),
        weight: Number(card.dataset.fiboWeight || 0),
        rect: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          right: round(rect.right),
          bottom: round(rect.bottom),
        },
        computed: {
          display: style.display,
          position: style.position,
          zIndex: style.zIndex,
          width: style.width,
          height: style.height,
        },
        titlebarHeight: round(titlebar ? titlebar.getBoundingClientRect().height : 0),
        contentHeight: round(content ? content.getBoundingClientRect().height : 0),
        contentScrollHeight: content ? content.scrollHeight : 0,
        collapseLabel: card.querySelector('[data-card-action="collapse-toggle"]')?.textContent?.trim() || null,
      };
    }).sort((left, right) => left.order - right.order);

    const container = document.querySelector('.fibo-adaptive-grid');
    const containerRect = container ? container.getBoundingClientRect() : { width: 0, height: 0 };
    const containerStyle = container ? getComputedStyle(container) : null;
    const debugLayout = window.__bellforgeStatusLayout || window.__bellforgeSettingsLayout || null;
    const layoutCache = debugLayout?.getLayoutCache?.() || null;
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      kind,
      url: window.location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      container: {
        width: round(containerRect.width),
        height: round(containerRect.height),
        gap: round(Number.parseFloat(containerStyle?.columnGap || containerStyle?.gap || rootStyle.getPropertyValue('--bf-masonry-gap') || '0') || 0),
        columns: Number(containerStyle?.getPropertyValue('--fibo-columns') || container?.style.getPropertyValue('--fibo-columns') || layoutCache?.columns || 0),
      },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      layoutMode: document.documentElement.dataset.designLayoutMode || layoutCache?.layoutMode || null,
      layoutCache,
      state: debugLayout?.getState?.() || null,
      pageDebug: window.__bellforgeDebug?.getLocalState?.() || null,
      debugInspector,
      cards,
    };
  }, { kind });
}

function assertNoOverlap(snapshot) {
  const overlaps = collectOverlaps(snapshot);
  assert.equal(overlaps.length, 0, `${snapshot.kind}: ${overlaps[0]?.left} overlaps ${overlaps[0]?.right}`);
}

function assertCardsRemainInGrid(snapshot) {
  snapshot.cards.forEach((card) => {
    assert.notEqual(card.tagName, 'button', `${snapshot.kind}: ${card.key} became a button`);
    assert.notEqual(card.computed.position, 'absolute', `${snapshot.kind}: ${card.key} left grid flow`);
    assert.notEqual(card.computed.position, 'fixed', `${snapshot.kind}: ${card.key} left grid flow`);
    assert.ok(card.rect.width > 0 && card.rect.height > 0, `${snapshot.kind}: ${card.key} is not visible`);
    assert.notEqual(card.computed.display, 'none', `${snapshot.kind}: ${card.key} is hidden`);
  });
}

function assertCollapseControls(snapshot, keys) {
  keys.forEach((key) => {
    const card = snapshot.cards.find((item) => item.key === key);
    assert.ok(card, `${snapshot.kind}: missing card ${key}`);
    assert.ok(card.collapseLabel === 'Collapse' || card.collapseLabel === 'Expand', `${snapshot.kind}: ${key} lost its collapse control`);
  });
}

function assertFibonacciRatios(snapshot, tolerance = 0.03) {
  const issues = findFibonacciRatioIssues(snapshot, tolerance);
  assert.equal(issues.length, 0, `${snapshot.kind}: masonry span check failed for ${issues[0]?.left} (${issues[0]?.actualRatio} vs ${issues[0]?.expectedRatio})`);
}

function assertWeightOrdering(snapshot) {
  const issues = findWeightOrderingIssues(snapshot);
  assert.equal(issues.length, 0, `${snapshot.kind}: heavier ${issues[0]?.heavier} should not get smaller slot than ${issues[0]?.lighter}`);
}

function assertExpectedColumns(snapshot, expectedColumns) {
  assert.equal(snapshot.container.columns, expectedColumns, `${snapshot.kind}: expected ${expectedColumns} tracks, got ${snapshot.container.columns}`);
}

function assertSpacing(snapshot, options = {}) {
  const metrics = collectSpacingMetrics(snapshot);
  const minVisibleCards = options.minVisibleCards ?? Math.min(snapshot.cards.length, 3);
  if (options.maxUnusedAreaRatio != null) {
    assert.ok(metrics.unusedAreaRatio <= options.maxUnusedAreaRatio, `${snapshot.kind}: wasted whitespace ratio ${metrics.unusedAreaRatio}`);
  }
  assert.ok(metrics.visibleCards >= minVisibleCards, `${snapshot.kind}: only ${metrics.visibleCards} cards are visible above the fold`);
  return metrics;
}

function assertSpacingBounds(snapshot, options = {}) {
  const metrics = collectSpacingMetrics(snapshot);
  if (options.maxVerticalGap != null) {
    assert.ok(metrics.maxVerticalGap <= options.maxVerticalGap, `${snapshot.kind}: vertical gap ${metrics.maxVerticalGap} exceeds ${options.maxVerticalGap}`);
  }
  if (options.maxHorizontalGap != null) {
    assert.ok(metrics.maxHorizontalGap <= options.maxHorizontalGap, `${snapshot.kind}: horizontal gap ${metrics.maxHorizontalGap} exceeds ${options.maxHorizontalGap}`);
  }
  if (options.minHorizontalGap != null && metrics.horizontalGaps.length > 0) {
    assert.ok(metrics.minHorizontalGap >= options.minHorizontalGap, `${snapshot.kind}: horizontal gap ${metrics.minHorizontalGap} is below ${options.minHorizontalGap}`);
  }
  return metrics;
}

function assertWhitespaceImproves(beforeSnapshot, afterSnapshot, label, allowance = 0.02) {
  const beforeMetrics = collectSpacingMetrics(beforeSnapshot);
  const afterMetrics = collectSpacingMetrics(afterSnapshot);
  assert.ok(afterMetrics.unusedAreaRatio <= beforeMetrics.unusedAreaRatio + allowance, `${label}: whitespace worsened from ${beforeMetrics.unusedAreaRatio} to ${afterMetrics.unusedAreaRatio}`);
}

function assertCollapsedCardsVisible(snapshot, keys) {
  for (const key of keys) {
    const card = snapshot.cards.find((item) => item.key === key);
    assert.ok(card, `${snapshot.kind}: missing card ${key}`);
    assert.equal(card.collapsed, true, `${snapshot.kind}: ${key} is not collapsed`);
    assert.equal(card.collapseLabel, 'Expand', `${snapshot.kind}: ${key} did not expose an expand control after collapse`);
    assert.ok(card.rect.width > 0 && card.rect.height > 0, `${snapshot.kind}: ${key} disappeared after collapse`);
  }
}

function assertMovement(beforeSnapshot, afterSnapshot, options = {}) {
  const delta = options.delta ?? 4;
  const cardKeys = options.keys || beforeSnapshot.cards.map((card) => card.key);
  const beforeMap = new Map(beforeSnapshot.cards.map((card) => [card.key, card]));
  const afterMap = new Map(afterSnapshot.cards.map((card) => [card.key, card]));
  let horizontal = false;
  let vertical = false;

  for (const key of cardKeys) {
    const before = beforeMap.get(key);
    const after = afterMap.get(key);
    if (!before || !after) {
      continue;
    }
    if (Math.abs(before.rect.x - after.rect.x) > delta) {
      horizontal = true;
    }
    if (Math.abs(before.rect.y - after.rect.y) > delta) {
      vertical = true;
    }
  }

  if (options.requireHorizontal !== false) {
    assert.equal(horizontal, true, `${afterSnapshot.kind}: expected horizontal movement after reflow`);
  }
  if (options.requireVertical !== false) {
    assert.equal(vertical, true, `${afterSnapshot.kind}: expected vertical movement after reflow`);
  }
}

function assertConsoleContains(entries, snippet, label) {
  assert.ok(entries.some((entry) => entry.text.includes(snippet)), `${label}: missing console log containing "${snippet}"`);
}

async function dragCard(target, sourceKey, targetKey) {
  await target.evaluate(({ sourceKey, targetKey }) => {
    const source = document.querySelector(`[data-card-key="${sourceKey}"] .card-titlebar`);
    const destination = document.querySelector(`[data-card-key="${targetKey}"] .card-titlebar`);
    if (!source || !destination) {
      throw new Error(`Unable to find drag handles for ${sourceKey} -> ${targetKey}`);
    }
    const dataTransfer = new DataTransfer();
    // Must set data during dragstart for the drop handler to receive it
    dataTransfer.setData('text/plain', sourceKey);
    const dragstartEvent = new DragEvent('dragstart', { 
      bubbles: true, 
      cancelable: true, 
      dataTransfer 
    });
    source.dispatchEvent(dragstartEvent);
    destination.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    destination.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
  }, { sourceKey, targetKey });
  await waitForLayoutReady(target);
  await target.evaluate(() => {
    window.__bellforgeStatusLayout?.recompute?.();
    window.__bellforgeSettingsLayout?.recompute?.();
  });
  await waitForLayoutReady(target);
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function collapseCard(target, key) {
  const expectedCollapsed = await target.evaluate((targetKey) => {
    const card = document.querySelector(`[data-card-key="${targetKey}"]`);
    return !card?.classList.contains('is-collapsed');
  }, key);
  await target.evaluate((targetKey) => {
    const button = document.querySelector(`[data-card-key="${targetKey}"] [data-card-action="collapse-toggle"]`);
    if (!button) {
      throw new Error(`Missing collapse button for ${targetKey}`);
    }
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, key);
  await target.waitForFunction(({ targetKey, expected }) => {
    const card = document.querySelector(`[data-card-key="${targetKey}"]`);
    return Boolean(card) && card.classList.contains('is-collapsed') === expected;
  }, { targetKey: key, expected: expectedCollapsed });
  await waitForLayoutReady(target);
}

async function setCardCollapsed(target, key, collapsed) {
  await target.evaluate(({ targetKey, nextCollapsed }) => {
    const statusLayout = window.__bellforgeStatusLayout;
    const settingsLayout = window.__bellforgeSettingsLayout;
    const applied = statusLayout?.setCardCollapsed?.(targetKey, nextCollapsed, 'browser-dom-verification')
      || settingsLayout?.setCardCollapsed?.(targetKey, nextCollapsed, 'browser-dom-verification');
    if (!applied) {
      throw new Error(`Unable to set collapsed state for ${targetKey}`);
    }
  }, { targetKey: key, nextCollapsed: collapsed });
  await target.waitForFunction(({ targetKey, expected }) => {
    const card = document.querySelector(`[data-card-key="${targetKey}"]`);
    return Boolean(card) && card.classList.contains('is-collapsed') === expected;
  }, { targetKey: key, expected: collapsed });
  await waitForLayoutReady(target);
}

async function readOrderedState(target) {
  return target.evaluate(() => Array.from(document.querySelectorAll('[data-fibo-card]'))
    .map((card) => ({
      key: card.dataset.cardKey,
      collapsed: card.classList.contains('is-collapsed'),
      order: Number(card.dataset.fiboOrder || 0),
    }))
    .sort((left, right) => left.order - right.order));
}

async function waitForOrderedState(target, expectedState) {
  await target.waitForFunction((expectedState) => {
    const currentState = Array.from(document.querySelectorAll('[data-fibo-card]'))
      .map((card) => ({
        key: card.dataset.cardKey,
        collapsed: card.classList.contains('is-collapsed'),
        order: Number(card.dataset.fiboOrder || 0),
      }))
      .sort((left, right) => left.order - right.order);
    return JSON.stringify(currentState) === JSON.stringify(expectedState);
  }, expectedState);
}

async function runScratchScenario(page, scenario) {
  return page.evaluate(async (scenario) => {
    const hostId = scenario.hostId || '__bellforgeScratchLayoutHost';
    document.getElementById(hostId)?.remove();

    if (scenario.storageKey) {
      if (scenario.stateRaw === undefined) {
        localStorage.removeItem(scenario.storageKey);
      } else if (typeof scenario.stateRaw === 'string') {
        localStorage.setItem(scenario.storageKey, scenario.stateRaw);
      } else {
        localStorage.setItem(scenario.storageKey, JSON.stringify(scenario.stateRaw));
      }
    }

    const container = document.createElement('div');
    container.id = hostId;
    container.className = scenario.mode === 'settings' ? 'grid' : 'wrap';
    container.style.width = `${scenario.containerWidth || 960}px`;
    container.style.maxWidth = `${scenario.containerWidth || 960}px`;
    container.style.margin = '24px';
    container.style.padding = '0';
    container.style.position = 'fixed';
    container.style.top = '24px';
    container.style.left = '24px';
    container.style.zIndex = '2147483647';
    container.style.background = 'transparent';
    document.body.prepend(container);
    window.scrollTo(0, 0);

    const cards = Array.isArray(scenario.cards) ? scenario.cards : [];
    cards.forEach((cardSpec, index) => {
      const tagName = cardSpec.tagName === 'details' ? 'details' : 'article';
      const card = document.createElement(tagName);
      card.dataset.fiboCard = 'true';
      if (cardSpec.key !== false && cardSpec.key != null) {
        card.dataset.cardKey = cardSpec.key;
      }
      if (cardSpec.title) {
        card.dataset.cardTitle = cardSpec.title;
      }
      if (cardSpec.helperText) {
        card.dataset.cardHelperText = cardSpec.helperText;
      }
      if (cardSpec.layoutPriority != null) {
        card.dataset.layoutPriority = String(cardSpec.layoutPriority);
      }
      if (cardSpec.layoutWeight != null) {
        card.dataset.layoutWeight = String(cardSpec.layoutWeight);
      }
      if (cardSpec.className) {
        card.className = cardSpec.className;
      }

      const title = cardSpec.title || `Scratch Card ${index + 1}`;
      if (tagName === 'details') {
        const summary = document.createElement('summary');
        const titleGroup = document.createElement('div');
        titleGroup.textContent = title;
        summary.appendChild(titleGroup);
        card.appendChild(summary);
        if (cardSpec.open !== false) {
          card.open = true;
        }
      } else if (cardSpec.omitHeading !== true) {
        const heading = document.createElement('h2');
        heading.textContent = title;
        card.appendChild(heading);
      }

      const body = document.createElement('div');
      body.textContent = cardSpec.content || 'Scratch layout content';
      if (cardSpec.graphic === true) {
        const image = document.createElement('img');
        image.alt = title;
        image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        body.appendChild(image);
      }
      if (tagName === 'details') {
        card.appendChild(body);
      } else {
        card.appendChild(body);
      }
      if (!card.className) {
        card.className = tagName === 'details' ? 'card advanced' : 'card';
      }
      container.appendChild(card);
    });

    Object.entries(scenario.rootTokens || {}).forEach(([name, value]) => {
      if (value == null) {
        document.documentElement.style.removeProperty(name);
      } else {
        document.documentElement.style.setProperty(name, String(value));
      }
    });

    const layoutHandle = window.BellForgeFibonacciLayout.createAdaptiveLayout({
      container,
      cardSelector: '[data-fibo-card]',
      storageKey: scenario.storageKey || `${hostId}.storage`,
      rowUnit: scenario.rowUnit || 8,
      collapsedHeightToken: scenario.collapsedHeightToken || '--bf-space-6',
      mode: scenario.mode || 'status',
      defaultPriorities: scenario.defaultPriorities || {},
      trackResolver: () => ({
        tracks: scenario.tracks || 5,
        maxPerRow: scenario.maxPerRow || 2,
      }),
    });

    (scenario.collapsedKeys || []).forEach((key) => {
      layoutHandle.setCardCollapsed(key, true, 'scratch-scenario');
    });
    if (scenario.autoArrange) {
      layoutHandle.autoArrange();
    } else {
      layoutHandle.recompute();
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const round = (value) => Math.round(value * 100) / 100;
    const cardsSnapshot = Array.from(container.querySelectorAll('[data-fibo-card]')).map((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const titlebar = card.querySelector('.card-titlebar');
      const content = card.querySelector('.card-content');
      return {
        key: card.dataset.cardKey,
        collapsed: card.classList.contains('is-collapsed'),
        rowIndex: Number(card.dataset.fiboRowIndex || 0),
        rowStart: Number(card.dataset.fiboRowStart || 0),
        colStart: Number(card.dataset.fiboColStart || 0),
        colSpan: Number(card.dataset.fiboColSpan || 0),
        rowSpan: Number(card.dataset.fiboRowSpan || 0),
        order: Number(card.dataset.fiboOrder || 0),
        weight: Number(card.dataset.fiboWeight || 0),
        rect: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          right: round(rect.right),
          bottom: round(rect.bottom),
        },
        computed: {
          display: style.display,
          position: style.position,
        },
        titlebarHeight: round(titlebar ? titlebar.getBoundingClientRect().height : 0),
        contentHeight: round(content ? content.getBoundingClientRect().height : 0),
      };
    }).sort((left, right) => left.order - right.order);

    const rect = container.getBoundingClientRect();
    const containerStyle = getComputedStyle(container);
    const snapshot = {
      kind: scenario.kind || 'scratch-layout',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      container: {
        width: round(rect.width),
        height: round(rect.height),
        gap: round(Number.parseFloat(containerStyle.columnGap || containerStyle.gap || '0') || 0),
        columns: Number(containerStyle.getPropertyValue('--fibo-columns') || container.style.getPropertyValue('--fibo-columns') || layoutHandle.getLayoutCache().columns || 0),
      },
      state: layoutHandle.getState(),
      layoutCache: layoutHandle.getLayoutCache(),
      cards: cardsSnapshot,
    };
    container.remove();
    return snapshot;
  }, scenario);
}

module.exports = {
  BASE_URL,
  STATUS_PATH,
  SETTINGS_PATH,
  DISPLAY_STATUS_PATH,
  DEFAULT_VIEWPORT,
  STORAGE_KEYS,
  registerBrowserSuite,
  openPage,
  openSettingsDisplayPage,
  openRealSurfaces,
  withRepair,
  captureSnapshot,
  broadcastStatusLayoutCommand,
  clickElement,
  waitForLayoutReady,
  writeArtifact,
  recordSnapshotArtifact,
  assertNoOverlap,
  assertCardsRemainInGrid,
  assertCollapseControls,
  assertFibonacciRatios,
  assertWeightOrdering,
  assertExpectedColumns,
  assertSpacing,
  assertSpacingBounds,
  assertWhitespaceImproves,
  assertCollapsedCardsVisible,
  assertMovement,
  assertConsoleContains,
  dragCard,
  collapseCard,
  setCardCollapsed,
  readOrderedState,
  waitForOrderedState,
  runScratchScenario,
  collectOverlaps,
  collectSpacingMetrics,
  countVisibleCards,
  simplifyLayout,
};