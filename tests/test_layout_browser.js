const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
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
const BASE_URL = 'http://127.0.0.1:8000';
const STATUS_PATH = '/status';
const SETTINGS_PATH = '/settings';
const DISPLAY_STATUS_PATH = '/status?view=display';
const BROWSER_LOG_DIR = path.join(REPO_ROOT, 'tests', 'logs', 'layout-browser');
const STORAGE_KEYS = [
  'bellforge.status.fibo-cards.v1',
  'bellforge.settings.fibo-cards.v1',
  'bellforge.status.layout-command.v1',
  'bellforge.design-controls.live.v1',
  'bellforge.debug.fibo',
];
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1600, height: 1000 },
  { width: 1280, height: 720 },
  { width: 800, height: 480 },
  { width: 480, height: 320 },
];

let browser;
let backendProcess = null;
let startedBackend = false;
let artifactSequence = 0;

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

function isServerHealthy() {
  return new Promise((resolve) => {
    const request = http.get(`${BASE_URL}/health`, (response) => {
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

function pythonCommandCandidates() {
  const candidates = [];
  const windowsVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  const posixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(windowsVenv)) candidates.push({ command: windowsVenv, args: [] });
  if (fs.existsSync(posixVenv)) candidates.push({ command: posixVenv, args: [] });
  if (process.env.BELLFORGE_PYTHON) candidates.push({ command: process.env.BELLFORGE_PYTHON, args: [] });
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', args: ['-3'] });
  }
  candidates.push({ command: 'python3', args: [] });
  candidates.push({ command: 'python', args: [] });
  return candidates;
}

async function ensureBackend() {
  if (await isServerHealthy()) {
    return;
  }

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
        '8000',
        '--log-level',
        'warning',
      ], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdout = '';
      backendProcess.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      backendProcess.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (await isServerHealthy()) {
          startedBackend = true;
          return;
        }
        if (backendProcess.exitCode != null) {
          break;
        }
        await sleep(500);
      }

      if (backendProcess.exitCode == null) {
        backendProcess.kill('SIGTERM');
      }
      backendProcess = null;
      writeArtifact('browser-backend-start-failure', {
        candidate,
        stdout,
        stderr,
      });
    } catch {
      backendProcess = null;
    }
  }

  throw new Error('Unable to start or reuse BellForge backend on http://127.0.0.1:8000');
}

async function stopBackend() {
  if (backendProcess && startedBackend && backendProcess.exitCode == null) {
    backendProcess.kill('SIGTERM');
    await sleep(1000);
    if (backendProcess.exitCode == null) {
      backendProcess.kill('SIGKILL');
    }
  }
  backendProcess = null;
}

function attachConsole(page, label) {
  const entries = [];
  page.on('console', async (message) => {
    const args = [];
    for (const handle of message.args()) {
      try {
        args.push(await handle.jsonValue());
      } catch {
        args.push(await handle.toString());
      }
    }
    entries.push({
      label,
      type: message.type(),
      text: message.text(),
      args,
    });
  });
  return entries;
}

async function waitForAnimationFrame(target) {
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForLayoutReady(target) {
  await target.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('[data-fibo-card]'));
    return cards.length > 0 && cards.every((card) => Number(card.dataset.fiboColSpan || 0) >= 1 && Number(card.dataset.fiboRowSpan || 0) >= 1);
  });
  await waitForAnimationFrame(target);
}

async function newContext(viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((keys) => {
    keys.forEach((key) => localStorage.removeItem(key));
    localStorage.setItem('bellforge.debug.fibo', 'true');
  }, STORAGE_KEYS);
  return context;
}

async function openPage(context, targetPath, label) {
  const page = await context.newPage();
  const consoleEntries = attachConsole(page, label);
  await page.goto(`${BASE_URL}${targetPath}`, { waitUntil: 'domcontentloaded' });
  await waitForLayoutReady(page);
  return { page, consoleEntries };
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
      window.__bellforgeStatusPreview?.close();
    }
  }, { kind, storageKeys: STORAGE_KEYS });
  await waitForLayoutReady(page);
}

async function withRepair(page, kind, label, runVerification) {
  try {
    return await runVerification('initial');
  } catch (error) {
    writeArtifact(`${label}-regression-initial`, { label, kind, error: { message: error.message, stack: error.stack } });
    await resetPageLayout(page, kind);
    try {
      return await runVerification('repaired');
    } catch (retryError) {
      writeArtifact(`${label}-regression-retry`, { label, kind, error: { message: retryError.message, stack: retryError.stack } });
      throw retryError;
    }
  }
}

async function captureSnapshot(target, kind) {
  return target.evaluate(({ kind }) => {
    const round = (value) => Math.round(value * 100) / 100;
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
          marginTop: style.marginTop,
          marginRight: style.marginRight,
          marginBottom: style.marginBottom,
          marginLeft: style.marginLeft,
          width: style.width,
          height: style.height,
        },
        titlebarHeight: round(titlebar ? titlebar.getBoundingClientRect().height : 0),
        contentHeight: round(content ? content.getBoundingClientRect().height : 0),
        contentScrollHeight: content ? content.scrollHeight : 0,
        hasTitlebar: Boolean(titlebar),
        collapseLabel: card.querySelector('[data-card-action="collapse-toggle"]')?.textContent?.trim() || null,
      };
    }).sort((left, right) => left.order - right.order);

    const container = document.querySelector('.fibo-adaptive-grid');
    const containerRect = container ? container.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const containerStyle = container ? getComputedStyle(container) : null;
    const debugLayout = window.__bellforgeStatusLayout || window.__bellforgeSettingsLayout || null;
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
        gap: round(Number.parseFloat(containerStyle?.columnGap || containerStyle?.gap || '0') || 0),
        columns: Number(containerStyle?.getPropertyValue('--fibo-columns') || container?.style.getPropertyValue('--fibo-columns') || 0),
      },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      layoutCache: debugLayout?.getLayoutCache?.() || null,
      state: debugLayout?.getState?.() || null,
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
  assert.equal(issues.length, 0, `${snapshot.kind}: ratio failed for ${issues[0]?.left}:${issues[0]?.right} (${issues[0]?.actualRatio} vs ${issues[0]?.expectedRatio})`);
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
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    destination.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    destination.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
  }, { sourceKey, targetKey });
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

async function openPreviewModal(page) {
  await page.evaluate(() => {
    window.__bellforgeStatusPreview?.open();
  });
  await page.waitForFunction(() => window.__bellforgeStatusPreview?.isOpen?.() === true);
  const handle = await page.$('#designStatusMirror');
  assert.ok(handle, 'Preview iframe is missing');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'Preview iframe did not expose a content frame');
  await waitForLayoutReady(frame);
  return frame;
}

before(async () => {
  await ensureBackend();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await stopBackend();
});

test('browser verification validates real status DOM collapse, expand, drag, ratios, and default layout', async () => {
  const context = await newContext({ width: 1280, height: 720 });
  const { page, consoleEntries } = await openPage(context, STATUS_PATH, 'status-page');

  await withRepair(page, 'status', 'status-dom-verification', async (attempt) => {
    const beforeCollapse = await captureSnapshot(page, `status-before-collapse-${attempt}`);
    writeArtifact(`status-before-collapse-${attempt}`, { snapshot: beforeCollapse, consoleEntries });
    assertCardsRemainInGrid(beforeCollapse);
    assertCollapseControls(beforeCollapse, ['setup-hero', 'quick-facts', 'browser-links', 'onboarding-qr', 'stats', 'advanced']);
    assertNoOverlap(beforeCollapse);
    assertFibonacciRatios(beforeCollapse);
    assertSpacing(beforeCollapse, { minVisibleCards: 2 });
    assert.deepEqual(beforeCollapse.cards.map((card) => card.key), ['setup-hero', 'quick-facts', 'browser-links', 'onboarding-qr', 'stats', 'advanced']);

    await collapseCard(page, 'stats');
    const afterCollapse = await captureSnapshot(page, `status-after-collapse-${attempt}`);
    writeArtifact(`status-after-collapse-${attempt}`, { snapshot: afterCollapse, consoleEntries });
    const collapsedStats = afterCollapse.cards.find((card) => card.key === 'stats');
    const beforeStats = beforeCollapse.cards.find((card) => card.key === 'stats');
    assert.ok(collapsedStats.rect.height <= collapsedStats.titlebarHeight + 24, 'Collapsed card did not shrink to title-only height');
    assert.equal(collapsedStats.collapsed, true, 'Collapsed card did not keep collapsed state');
    assert.ok(collapsedStats.rect.y >= beforeCollapse.cards.find((card) => card.key === 'browser-links').rect.y, 'Collapsed card floated to the top');
    assert.ok(collapsedStats.rect.height < beforeStats.rect.height, 'Collapsed card height did not reduce');
    assertCardsRemainInGrid(afterCollapse);
    assertCollapsedCardsVisible(afterCollapse, ['stats']);
    assertNoOverlap(afterCollapse);
    assertSpacing(afterCollapse, { minVisibleCards: countVisibleCards(beforeCollapse) });
    assert.ok(countVisibleCards(afterCollapse) >= countVisibleCards(beforeCollapse), 'Collapsing a card did not maximize visible cards');
    assertWhitespaceImproves(beforeCollapse, afterCollapse, 'status collapse density');

    await collapseCard(page, 'stats');
    const afterExpand = await captureSnapshot(page, `status-after-expand-${attempt}`);
    writeArtifact(`status-after-expand-${attempt}`, { snapshot: afterExpand, consoleEntries });
    const expandedStats = afterExpand.cards.find((card) => card.key === 'stats');
    const advancedAfterCollapse = afterCollapse.cards.find((card) => card.key === 'advanced');
    const advancedAfterExpand = afterExpand.cards.find((card) => card.key === 'advanced');
    assert.equal(expandedStats.collapsed, false, 'Card did not expand again');
    assert.ok(advancedAfterExpand.rect.y >= advancedAfterCollapse.rect.y, 'Expanding a card did not push later cards back down');
    assertNoOverlap(afterExpand);
    assertSpacing(afterExpand, { minVisibleCards: 2 });

    await dragCard(page, 'advanced', 'browser-links');
    const afterDrag = await captureSnapshot(page, `status-after-drag-${attempt}`);
    writeArtifact(`status-after-drag-${attempt}`, { snapshot: afterDrag, consoleEntries });
    const advancedIndex = afterDrag.cards.findIndex((card) => card.key === 'advanced');
    const browserLinksIndex = afterDrag.cards.findIndex((card) => card.key === 'browser-links');
    assert.ok(advancedIndex >= 0 && browserLinksIndex >= 0 && advancedIndex + 1 === browserLinksIndex, 'Drag-and-drop did not place Advanced Diagnostics immediately before Browser Links');
    assertNoOverlap(afterDrag);
    assertFibonacciRatios(afterDrag);

    await page.setViewportSize({ width: 800, height: 480 });
    await waitForLayoutReady(page);
    const afterResizeSmall = await captureSnapshot(page, `status-after-resize-small-${attempt}`);
    writeArtifact(`status-after-resize-small-${attempt}`, { snapshot: afterResizeSmall, consoleEntries });
    assertExpectedColumns(afterResizeSmall, 5);
    assert.notDeepEqual(simplifyLayout(afterResizeSmall), simplifyLayout(afterDrag), 'Status layout did not reflow after resize');
    assertNoOverlap(afterResizeSmall);

    await collapseCard(page, 'stats');
    const beforeTokenChange = await captureSnapshot(page, `status-before-token-change-${attempt}`);
    writeArtifact(`status-before-token-change-${attempt}`, { snapshot: beforeTokenChange, consoleEntries });

    const spacingBeforeToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bf-space-6').trim());
    await page.evaluate(() => {
      window.postMessage({
        type: 'bellforge-design-controls',
        payload: {
          theme: 'warm',
          font_scale: 1,
          ui_scale: 1.2,
          card_radius_px: 24,
          shadow_intensity: 1,
          status_page_scale: 0.75,
        },
      }, window.location.origin);
    });
    await waitForLayoutReady(page);
    const afterTokenChange = await captureSnapshot(page, `status-after-token-change-${attempt}`);
    writeArtifact(`status-after-token-change-${attempt}`, { snapshot: afterTokenChange, consoleEntries });
    const spacingAfterToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bf-space-6').trim());
    const collapsedStatsBeforeToken = beforeTokenChange.cards.find((card) => card.key === 'stats');
    const collapsedStatsAfterToken = afterTokenChange.cards.find((card) => card.key === 'stats');
    assert.notEqual(spacingAfterToken, spacingBeforeToken, 'Token changes did not update live spacing tokens');
    assert.ok(collapsedStatsAfterToken.rect.height > collapsedStatsBeforeToken.rect.height, 'Status layout did not reflow after token changes');
    assertNoOverlap(afterTokenChange);
    assertFibonacciRatios(afterTokenChange);
    assertSpacing(afterTokenChange, { minVisibleCards: 2 });
  });

  assertConsoleContains(consoleEntries, 'default layout generation', 'status console');
  assertConsoleContains(consoleEntries, 'Fibonacci slot assignments', 'status console');
  assertConsoleContains(consoleEntries, 'collapse/expand events', 'status console');
  assertConsoleContains(consoleEntries, 'drag-and-drop events', 'status console');
  assertConsoleContains(consoleEntries, 'token application', 'status console');
  assertConsoleContains(consoleEntries, 'card reflow events', 'status console');

  await context.close();
});

test('browser verification validates settings collapse density, multi-expand reflow, and auto-arrange repair', async () => {
  const context = await newContext({ width: 1280, height: 720 });
  const { page, consoleEntries } = await openPage(context, SETTINGS_PATH, 'settings-layout-behavior');
  const cardKeys = ['display-pipeline', 'network', 'autoupdater', 'design-controls', 'authentication', 'logs'];

  await withRepair(page, 'settings', 'settings-dom-verification', async (attempt) => {
    const before = await captureSnapshot(page, `settings-before-${attempt}`);
    writeArtifact(`settings-before-${attempt}`, { snapshot: before, consoleEntries });
    assertCardsRemainInGrid(before);
    assertNoOverlap(before);
    assertFibonacciRatios(before);
    assertWeightOrdering(before);
    assertSpacing(before, { minVisibleCards: 2 });

    for (const key of cardKeys) {
      await setCardCollapsed(page, key, true);
    }
    const allCollapsed = await captureSnapshot(page, `settings-all-collapsed-${attempt}`);
    writeArtifact(`settings-all-collapsed-${attempt}`, { snapshot: allCollapsed, consoleEntries });
    assertCollapsedCardsVisible(allCollapsed, cardKeys);
    assertNoOverlap(allCollapsed);
    assertFibonacciRatios(allCollapsed);
    assertSpacing(allCollapsed, { maxUnusedAreaRatio: 0.5, minVisibleCards: cardKeys.length });
    assert.equal(countVisibleCards(allCollapsed), cardKeys.length, 'Collapsed settings cards did not pack tightly on screen');
    assert.ok(countVisibleCards(allCollapsed) >= countVisibleCards(before), 'Collapsed settings layout reduced visible cards');
    assertWhitespaceImproves(before, allCollapsed, 'settings collapse density');

    await setCardCollapsed(page, 'network', false);
    await setCardCollapsed(page, 'design-controls', false);
    const multiExpanded = await captureSnapshot(page, `settings-multi-expanded-${attempt}`);
    writeArtifact(`settings-multi-expanded-${attempt}`, { snapshot: multiExpanded, consoleEntries });
    assert.equal(multiExpanded.cards.find((card) => card.key === 'network')?.collapsed, false, 'Network card did not expand');
    assert.equal(multiExpanded.cards.find((card) => card.key === 'design-controls')?.collapsed, false, 'Design controls card did not expand');
    assertNoOverlap(multiExpanded);
    assertSpacing(multiExpanded, { minVisibleCards: 2 });
    assertMovement(allCollapsed, multiExpanded, { requireHorizontal: false, requireVertical: true });

    await dragCard(page, 'logs', 'network');
    const afterDrag = await captureSnapshot(page, `settings-after-drag-${attempt}`);
    writeArtifact(`settings-after-drag-${attempt}`, { snapshot: afterDrag, consoleEntries });
    assert.ok(afterDrag.cards.findIndex((card) => card.key === 'logs') < afterDrag.cards.findIndex((card) => card.key === 'network'), 'Settings drag-and-drop did not reorder cards');
    assertNoOverlap(afterDrag);

    await page.evaluate(() => {
      window.__bellforgeSettingsLayout?.autoArrange?.();
    });
    await waitForLayoutReady(page);
    const afterAutoArrange = await captureSnapshot(page, `settings-after-auto-arrange-${attempt}`);
    writeArtifact(`settings-after-auto-arrange-${attempt}`, { snapshot: afterAutoArrange, consoleEntries });
    assert.notDeepEqual(simplifyLayout(afterAutoArrange), simplifyLayout(afterDrag), 'Settings auto arrange did not visibly rearrange cards');
    assertNoOverlap(afterAutoArrange);
    assertFibonacciRatios(afterAutoArrange);
    assertMovement(afterDrag, afterAutoArrange, { requireHorizontal: true, requireVertical: true });
  });

  assertConsoleContains(consoleEntries, 'collapse/expand events', 'settings console');
  assertConsoleContains(consoleEntries, 'drag-and-drop events', 'settings console');
  assertConsoleContains(consoleEntries, 'auto-arrange events', 'settings console');
  assertConsoleContains(consoleEntries, 'card reflow events', 'settings console');

  await context.close();
});

test('browser verification validates responsive reflow across viewport matrix for status and settings', async () => {
  for (const viewport of VIEWPORTS) {
    const context = await newContext(viewport);
    const { page: statusPage, consoleEntries: statusConsole } = await openPage(context, STATUS_PATH, `status-${viewport.width}x${viewport.height}`);
    await withRepair(statusPage, 'status', `status-responsive-${viewport.width}x${viewport.height}`, async (attempt) => {
      const statusSnapshot = await captureSnapshot(statusPage, `status-${viewport.width}x${viewport.height}-${attempt}`);
      writeArtifact(`status-responsive-${viewport.width}x${viewport.height}-${attempt}`, { snapshot: statusSnapshot, consoleEntries: statusConsole });
      assertCardsRemainInGrid(statusSnapshot);
      assertNoOverlap(statusSnapshot);
      assertFibonacciRatios(statusSnapshot);
      const expectedColumns = statusSnapshot.container.width >= 1240 ? 10 : statusSnapshot.container.width >= 660 ? 5 : 1;
      assertExpectedColumns(statusSnapshot, expectedColumns);
    });

    const { page: settingsPage, consoleEntries: settingsConsole } = await openPage(context, SETTINGS_PATH, `settings-${viewport.width}x${viewport.height}`);
    await withRepair(settingsPage, 'settings', `settings-responsive-${viewport.width}x${viewport.height}`, async (attempt) => {
      const settingsSnapshot = await captureSnapshot(settingsPage, `settings-${viewport.width}x${viewport.height}-${attempt}`);
      writeArtifact(`settings-responsive-${viewport.width}x${viewport.height}-${attempt}`, { snapshot: settingsSnapshot, consoleEntries: settingsConsole });
      assertCardsRemainInGrid(settingsSnapshot);
      assertNoOverlap(settingsSnapshot);
      assertFibonacciRatios(settingsSnapshot);
      const expectedColumns = settingsSnapshot.container.width >= 1180 ? 10 : settingsSnapshot.container.width >= 620 ? 5 : 1;
      assertExpectedColumns(settingsSnapshot, expectedColumns);
    });
    await context.close();
  }
});

test('browser verification keeps status onboarding card stable with long live-like onboarding URLs', async () => {
  const viewport = { width: 1600, height: 1000 };
  const context = await newContext(viewport);
  const { page, consoleEntries } = await openPage(context, STATUS_PATH, 'status-live-like-onboarding');

  await page.evaluate(() => {
    const longToken = 'h7vIp-pairing-token-' + 'Ab9xYz'.repeat(48);
    const baseUrl = 'http://192.168.2.180:8000';
    const longOnboardingUrl = `http://192.168.2.180:8000/client/onboarding.html?pairing_token=${longToken}`;
    const directLink = document.getElementById('onboardingDirectUrl');
    const status = document.getElementById('onboardingQrStatus');
    const image = document.getElementById('onboardingQr');
    const browserLinks = [
      ['accessUrl', `${baseUrl}`],
      ['settingsUrl', `${baseUrl}/settings`],
      ['authUrl', `${baseUrl}/client/auth.html`],
      ['onboardingUrl', longOnboardingUrl],
      ['automodeUrl', `${baseUrl}/client/automode.html`],
    ];
    if (!directLink || !status || !image) {
      throw new Error('Onboarding QR elements are missing');
    }
    browserLinks.forEach(([id, value]) => {
      const link = document.getElementById(id);
      if (!link) {
        throw new Error(`Missing browser link ${id}`);
      }
      link.textContent = value;
      link.href = value;
      link.title = value;
    });
    directLink.textContent = longOnboardingUrl;
    directLink.href = longOnboardingUrl;
    directLink.title = longOnboardingUrl;
    status.textContent = 'Scan to start. Pairing code: 63378984';
    image.src = `/api/qr/svg?text=${encodeURIComponent(longOnboardingUrl)}`;
    window.__bellforgeStatusLayout?.recompute?.();
  });
  await waitForLayoutReady(page);

  const snapshot = await captureSnapshot(page, 'status-live-like-onboarding');
  writeArtifact('status-live-like-onboarding', { snapshot, consoleEntries });
  assertCardsRemainInGrid(snapshot);
  assertNoOverlap(snapshot);
  const browserLinksCard = snapshot.cards.find((card) => card.key === 'browser-links');
  const onboardingCard = snapshot.cards.find((card) => card.key === 'onboarding-qr');
  assert.ok(browserLinksCard, 'Browser Links card is missing');
  assert.ok(onboardingCard, 'Onboarding QR card is missing');
  assert.ok(browserLinksCard.rect.height < 1200, 'Browser Links card grew to an unreasonable height with long live URLs');
  assert.ok(onboardingCard.rect.height < 1400, 'Onboarding QR card grew to an unreasonable height with a long live onboarding URL');

  await context.close();
});

test('browser verification validates preview modal scale, mirrored layout, collapse, and drag behavior', async () => {
  const context = await newContext({ width: 1280, height: 720 });
  const { page: referencePage, consoleEntries: referenceConsole } = await openPage(context, DISPLAY_STATUS_PATH, 'status-display-reference');
  const initialReferenceSnapshot = await captureSnapshot(referencePage, 'status-display-reference');
  writeArtifact('status-display-reference', { snapshot: initialReferenceSnapshot, consoleEntries: referenceConsole });

  const { page: settingsPage, consoleEntries: settingsConsole } = await openPage(context, SETTINGS_PATH, 'settings-preview');
  await withRepair(settingsPage, 'settings', 'settings-preview-modal', async (attempt) => {
    const referenceSnapshot = await captureSnapshot(referencePage, `status-display-reference-${attempt}`);
    writeArtifact(`status-display-reference-${attempt}`, { snapshot: referenceSnapshot, consoleEntries: referenceConsole });
    const previewFrame = await openPreviewModal(settingsPage);
    const previewConsole = attachConsole(previewFrame.page(), `preview-frame-${attempt}`);
    const modalMetrics = await settingsPage.evaluate(() => {
      const modal = document.getElementById('designStatusPreviewModal');
      const dialog = modal?.querySelector('.status-preview-modal__dialog');
      const rootStyle = getComputedStyle(document.documentElement);
      const modalRect = modal?.getBoundingClientRect();
      const dialogRect = dialog?.getBoundingClientRect();
      return {
        modalPosition: modal ? getComputedStyle(modal).position : null,
        modalRect: modalRect ? { width: modalRect.width, height: modalRect.height } : null,
        dialogRect: dialogRect ? { width: dialogRect.width, height: dialogRect.height } : null,
        nativeWidth: Number(rootStyle.getPropertyValue('--status-preview-native-width') || 0),
        nativeHeight: Number(rootStyle.getPropertyValue('--status-preview-native-height') || 0),
        viewportWidth: Number.parseFloat(rootStyle.getPropertyValue('--status-preview-modal-width') || '0'),
        viewportHeight: Number.parseFloat(rootStyle.getPropertyValue('--status-preview-modal-height') || '0'),
        resolutionLabel: document.getElementById('designStatusResolution')?.textContent?.trim() || '',
        previewOpen: window.__bellforgeStatusPreview?.isOpen?.() || false,
      };
    });
    const previewSnapshot = await captureSnapshot(previewFrame, `status-preview-frame-${attempt}`);
    writeArtifact(`status-preview-frame-${attempt}`, {
      modalMetrics,
      referenceSnapshot,
      previewSnapshot,
      settingsConsoleEntries: settingsConsole,
      previewConsoleEntries: previewConsole,
    });

    assert.equal(modalMetrics.previewOpen, true, 'Preview modal did not open');
    assert.equal(modalMetrics.modalPosition, 'fixed', 'Preview modal is not fixed full-screen');
  assert.ok(Math.abs(modalMetrics.modalRect.width - 1280) <= 4, 'Preview modal overlay does not span the full viewport width');
  assert.ok(Math.abs(modalMetrics.modalRect.height - 720) <= 4, 'Preview modal overlay does not span the full viewport height');
    assert.ok(modalMetrics.nativeWidth >= 800 && modalMetrics.nativeHeight >= 480, 'Preview modal chose an unexpectedly tiny display resolution');
    const nativeRatio = modalMetrics.nativeWidth / modalMetrics.nativeHeight;
    const viewportRatio = modalMetrics.viewportWidth / modalMetrics.viewportHeight;
    assert.ok(Math.abs(nativeRatio - viewportRatio) / nativeRatio <= 0.03, 'Preview modal scaling is not proportional to the target display');
    assert.ok(modalMetrics.resolutionLabel.length > 0, 'Preview modal did not report its size calculation');
    assert.ok(previewFrame.url().includes('/status?view=display'), 'Preview iframe is not using the real status display page');
    assert.deepEqual(simplifyLayout(previewSnapshot), simplifyLayout(referenceSnapshot), 'Preview layout does not match the real status display layout');
    assertCardsRemainInGrid(previewSnapshot);
    assertNoOverlap(previewSnapshot);
    assertFibonacciRatios(previewSnapshot);
    assertSpacing(previewSnapshot, { minVisibleCards: 2 });

    await setCardCollapsed(previewFrame, 'advanced', true);
    const collapsedPreview = await captureSnapshot(previewFrame, `status-preview-collapsed-${attempt}`);
    writeArtifact(`status-preview-collapsed-${attempt}`, { snapshot: collapsedPreview, settingsConsoleEntries: settingsConsole, previewConsoleEntries: previewConsole });
    const previewAdvanced = collapsedPreview.cards.find((card) => card.key === 'advanced');
    assert.equal(previewAdvanced.collapsed, true, 'Preview collapse did not apply');
    assert.ok(previewAdvanced.rect.height <= previewAdvanced.titlebarHeight + 24, 'Preview collapsed card did not shrink to title-only height');
    assertNoOverlap(collapsedPreview);
    await waitForLayoutReady(referencePage);
    const referenceAfterCollapse = await captureSnapshot(referencePage, `status-reference-after-preview-collapse-${attempt}`);
    writeArtifact(`status-reference-after-preview-collapse-${attempt}`, { snapshot: referenceAfterCollapse, consoleEntries: referenceConsole });
    assert.equal(referenceAfterCollapse.cards.find((card) => card.key === 'advanced')?.collapsed, true, 'Preview collapse did not update the real status page');

    await dragCard(previewFrame, 'advanced', 'browser-links');
    const draggedPreview = await captureSnapshot(previewFrame, `status-preview-dragged-${attempt}`);
    writeArtifact(`status-preview-dragged-${attempt}`, { snapshot: draggedPreview, settingsConsoleEntries: settingsConsole, previewConsoleEntries: previewConsole });
    const previewAdvancedIndex = draggedPreview.cards.findIndex((card) => card.key === 'advanced');
    const previewBrowserLinksIndex = draggedPreview.cards.findIndex((card) => card.key === 'browser-links');
    assert.ok(previewAdvancedIndex >= 0 && previewBrowserLinksIndex >= 0 && previewAdvancedIndex + 1 === previewBrowserLinksIndex, 'Preview drag-and-drop did not place Advanced Diagnostics immediately before Browser Links');
    assertNoOverlap(draggedPreview);
    await waitForLayoutReady(referencePage);
    const referenceAfterDrag = await captureSnapshot(referencePage, `status-reference-after-preview-drag-${attempt}`);
    writeArtifact(`status-reference-after-preview-drag-${attempt}`, { snapshot: referenceAfterDrag, consoleEntries: referenceConsole });
    assert.deepEqual(simplifyLayout(referenceAfterDrag), simplifyLayout(draggedPreview), 'Preview drag-and-drop did not update the real status page layout');

    await settingsPage.evaluate(() => {
      window.__bellforgeStatusPreview?.autoArrange?.();
    });
    await waitForLayoutReady(previewFrame);
    await waitForLayoutReady(referencePage);
    const previewAfterAuto = await captureSnapshot(previewFrame, `status-preview-auto-arranged-${attempt}`);
    const referenceAfterAuto = await captureSnapshot(referencePage, `status-reference-auto-arranged-${attempt}`);
    writeArtifact(`status-preview-auto-arranged-${attempt}`, {
      previewSnapshot: previewAfterAuto,
      referenceSnapshot: referenceAfterAuto,
      settingsConsoleEntries: settingsConsole,
      previewConsoleEntries: previewConsole,
      referenceConsoleEntries: referenceConsole,
    });
    assert.notDeepEqual(simplifyLayout(previewAfterAuto), simplifyLayout(draggedPreview), 'Preview auto arrange did not visibly rearrange cards');
    assert.deepEqual(simplifyLayout(previewAfterAuto), simplifyLayout(referenceAfterAuto), 'Preview auto arrange did not update the real status page');
    assertFibonacciRatios(previewAfterAuto);

    await dragCard(referencePage, 'stats', 'advanced');
    const referenceAfterLiveDrag = await captureSnapshot(referencePage, `status-reference-live-drag-${attempt}`);
    writeArtifact(`status-reference-live-drag-${attempt}`, { snapshot: referenceAfterLiveDrag, consoleEntries: referenceConsole });
    await settingsPage.evaluate(() => {
      window.__bellforgeStatusPreview?.sync?.();
    });
    await waitForLayoutReady(previewFrame);
    const previewAfterSync = await captureSnapshot(previewFrame, `status-preview-after-sync-${attempt}`);
    writeArtifact(`status-preview-after-sync-${attempt}`, {
      previewSnapshot: previewAfterSync,
      referenceSnapshot: referenceAfterLiveDrag,
      settingsConsoleEntries: settingsConsole,
      previewConsoleEntries: previewConsole,
      referenceConsoleEntries: referenceConsole,
    });
    assert.deepEqual(simplifyLayout(previewAfterSync), simplifyLayout(referenceAfterLiveDrag), 'Preview sync did not refresh the preview to the real status layout');
  });

  assertConsoleContains(settingsConsole, 'preview expansion/collapse', 'settings preview console');
  assertConsoleContains(settingsConsole, 'preview-to-status sync events', 'settings preview console');
  assertConsoleContains(settingsConsole, 'window resize reflow', 'settings preview console');

  await context.close();
});