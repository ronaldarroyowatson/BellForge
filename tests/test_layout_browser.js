const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { chromium } = require('playwright');

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
      layoutCache: debugLayout?.getLayoutCache?.() || null,
      state: debugLayout?.getState?.() || null,
      cards,
    };
  }, { kind });
}

function rowGroups(snapshot) {
  const groups = new Map();
  snapshot.cards.forEach((card) => {
    if (!groups.has(card.rowIndex)) groups.set(card.rowIndex, []);
    groups.get(card.rowIndex).push(card);
  });
  return Array.from(groups.values()).map((items) => items.sort((left, right) => left.colStart - right.colStart));
}

function assertNoOverlap(snapshot) {
  const cards = snapshot.cards;
  for (let index = 0; index < cards.length; index += 1) {
    for (let compare = index + 1; compare < cards.length; compare += 1) {
      const left = cards[index].rect;
      const right = cards[compare].rect;
      const overlaps = !(left.bottom <= right.y + 1 || right.bottom <= left.y + 1 || left.right <= right.x + 1 || right.right <= left.x + 1);
      assert.equal(overlaps, false, `${snapshot.kind}: ${cards[index].key} overlaps ${cards[compare].key}`);
    }
  }
}

function assertCardsRemainInGrid(snapshot) {
  snapshot.cards.forEach((card) => {
    assert.notEqual(card.tagName, 'button', `${snapshot.kind}: ${card.key} became a button`);
    assert.notEqual(card.computed.position, 'absolute', `${snapshot.kind}: ${card.key} left grid flow`);
    assert.notEqual(card.computed.position, 'fixed', `${snapshot.kind}: ${card.key} left grid flow`);
    assert.ok(card.rect.width > 0 && card.rect.height > 0, `${snapshot.kind}: ${card.key} is not visible`);
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
  const gap = snapshot.container.gap || 0;
  rowGroups(snapshot).forEach((items) => {
    if (items.length <= 1) {
      return;
    }
    const normalizedWidths = items.map((item) => item.rect.width - ((item.colSpan - 1) * gap));
    const expectedSpans = items.map((item) => item.colSpan);
    for (let index = 1; index < items.length; index += 1) {
      const actualRatio = normalizedWidths[index - 1] / normalizedWidths[index];
      const expectedRatio = expectedSpans[index - 1] / expectedSpans[index];
      const delta = Math.abs(actualRatio - expectedRatio) / expectedRatio;
      assert.ok(delta <= tolerance, `${snapshot.kind}: ratio failed for ${items[index - 1].key}:${items[index].key} (${actualRatio.toFixed(3)} vs ${expectedRatio.toFixed(3)})`);
    }
  });
}

function assertWeightOrdering(snapshot) {
  const cards = snapshot.cards;
  for (let index = 0; index < cards.length; index += 1) {
    for (let compare = index + 1; compare < cards.length; compare += 1) {
      if (cards[index].weight > cards[compare].weight) {
        assert.ok(cards[index].colSpan >= cards[compare].colSpan, `${snapshot.kind}: heavier ${cards[index].key} should not get smaller slot than ${cards[compare].key}`);
      }
    }
  }
}

function assertExpectedColumns(snapshot, expectedColumns) {
  assert.equal(snapshot.container.columns, expectedColumns, `${snapshot.kind}: expected ${expectedColumns} tracks, got ${snapshot.container.columns}`);
}

function simplifyLayout(snapshot) {
  return snapshot.cards.map((card) => ({
    key: card.key,
    collapsed: card.collapsed,
    rowIndex: card.rowIndex,
    colStart: card.colStart,
    colSpan: card.colSpan,
    order: card.order,
  }));
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
  await waitForLayoutReady(target);
}

async function collapseCard(target, key) {
  await target.locator(`[data-card-key="${key}"] [data-card-action="collapse-toggle"]`).click();
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
    assertCollapseControls(beforeCollapse, ['browser-links', 'stats', 'advanced']);
    assertNoOverlap(beforeCollapse);
    assertFibonacciRatios(beforeCollapse);
    assertWeightOrdering(beforeCollapse);
    assert.deepEqual(beforeCollapse.cards.map((card) => card.key), ['hero', 'browser-links', 'onboarding-qr', 'stats', 'advanced']);

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
    assertNoOverlap(afterCollapse);

    await collapseCard(page, 'stats');
    const afterExpand = await captureSnapshot(page, `status-after-expand-${attempt}`);
    writeArtifact(`status-after-expand-${attempt}`, { snapshot: afterExpand, consoleEntries });
    const expandedStats = afterExpand.cards.find((card) => card.key === 'stats');
    const advancedAfterCollapse = afterCollapse.cards.find((card) => card.key === 'advanced');
    const advancedAfterExpand = afterExpand.cards.find((card) => card.key === 'advanced');
    assert.equal(expandedStats.collapsed, false, 'Card did not expand again');
    assert.ok(advancedAfterExpand.rect.y >= advancedAfterCollapse.rect.y, 'Expanding a card did not push later cards back down');
    assertNoOverlap(afterExpand);

    await dragCard(page, 'advanced', 'browser-links');
    const afterDrag = await captureSnapshot(page, `status-after-drag-${attempt}`);
    writeArtifact(`status-after-drag-${attempt}`, { snapshot: afterDrag, consoleEntries });
    assert.equal(afterDrag.cards[1].key, 'advanced', 'Drag-and-drop did not reorder cards');
    assertNoOverlap(afterDrag);
    assertFibonacciRatios(afterDrag);
  });

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

test('browser verification validates preview modal scale, mirrored layout, collapse, and drag behavior', async () => {
  const context = await newContext({ width: 1280, height: 720 });
  const { page: referencePage, consoleEntries: referenceConsole } = await openPage(context, DISPLAY_STATUS_PATH, 'status-display-reference');
  const referenceSnapshot = await captureSnapshot(referencePage, 'status-display-reference');
  writeArtifact('status-display-reference', { snapshot: referenceSnapshot, consoleEntries: referenceConsole });

  const { page: settingsPage, consoleEntries: settingsConsole } = await openPage(context, SETTINGS_PATH, 'settings-preview');
  await withRepair(settingsPage, 'settings', 'settings-preview-modal', async (attempt) => {
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

    await collapseCard(previewFrame, 'advanced');
    const collapsedPreview = await captureSnapshot(previewFrame, `status-preview-collapsed-${attempt}`);
    writeArtifact(`status-preview-collapsed-${attempt}`, { snapshot: collapsedPreview, settingsConsoleEntries: settingsConsole, previewConsoleEntries: previewConsole });
    const previewAdvanced = collapsedPreview.cards.find((card) => card.key === 'advanced');
    assert.equal(previewAdvanced.collapsed, true, 'Preview collapse did not apply');
    assert.ok(previewAdvanced.rect.height <= previewAdvanced.titlebarHeight + 24, 'Preview collapsed card did not shrink to title-only height');
    assertNoOverlap(collapsedPreview);

    await dragCard(previewFrame, 'advanced', 'browser-links');
    const draggedPreview = await captureSnapshot(previewFrame, `status-preview-dragged-${attempt}`);
    writeArtifact(`status-preview-dragged-${attempt}`, { snapshot: draggedPreview, settingsConsoleEntries: settingsConsole, previewConsoleEntries: previewConsole });
    assert.equal(draggedPreview.cards[1].key, 'advanced', 'Preview drag-and-drop did not reorder cards');
    assertNoOverlap(draggedPreview);
  });

  await context.close();
});