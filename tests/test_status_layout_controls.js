const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  dragCard,
  waitForLayoutReady,
  assertConsoleContains,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();
const DEFAULT_STATUS_ORDER = ['browser-links', 'onboarding-qr', 'stats', 'advanced', 'setup-hero', 'quick-facts'];

function orderedKeys(snapshot) {
  return snapshot.cards.map((card) => card.key);
}

async function forceEnableStatusEditMode(page) {
  await page.evaluate(() => {
    const settingsKey = 'bellforge.status.layout-settings.v1';
    const stored = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    localStorage.setItem(settingsKey, JSON.stringify({
      minCardWidth: Number(stored.minCardWidth || 300),
      gap: Number(stored.gap || 12),
      editEnabled: true,
    }));
    window.__bellforgeStatusLayout?.enableEditMode?.();
  });
  await waitForLayoutReady(page);
}

test('status edit mode drag updates order and persists layout state', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'status-layout-drag-controls');

  try {
    await forceEnableStatusEditMode(surfaces.statusPage);

    const beforeDrag = await captureSnapshot(surfaces.statusPage, 'status-layout-controls-before-drag');
    await dragCard(surfaces.statusPage, 'advanced', 'browser-links');
    const afterDrag = await captureSnapshot(surfaces.statusPage, 'status-layout-controls-after-drag');
    const storedState = await surfaces.statusPage.evaluate(() => JSON.parse(localStorage.getItem('bellforge.status.fibo-cards.v1') || '{}'));

    assert.deepEqual(orderedKeys(beforeDrag), DEFAULT_STATUS_ORDER, 'Status page did not start from the expected default order');
    assert.deepEqual(
      orderedKeys(afterDrag),
      ['advanced', 'browser-links', 'onboarding-qr', 'stats', 'setup-hero', 'quick-facts'],
      'Edit-mode drag did not update the in-memory layout order deterministically',
    );
    assert.equal(storedState.advanced?.order, 0, 'Dragged card order was not persisted through saveLayout');
    assert.equal(storedState['browser-links']?.order, 1, 'Target card order was not persisted after drag');

    assertConsoleContains(surfaces.statusConsole, 'edit mode enabled', 'status drag console');
    assertConsoleContains(surfaces.statusConsole, 'drag start', 'status drag console');
    assertConsoleContains(surfaces.statusConsole, 'drag end', 'status drag console');
    assertConsoleContains(surfaces.statusConsole, 'layout save attempt', 'status drag console');
  } finally {
    await surfaces.context.close();
  }
});

test('status layout sliders trigger immediate reflow and save the updated settings', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'status-layout-slider-controls');

  try {
    const before = await captureSnapshot(surfaces.statusPage, 'status-layout-controls-before-slider');

    await surfaces.statusPage.evaluate(() => {
      const minWidth = document.getElementById('layoutMinWidth');
      const gap = document.getElementById('layoutGap');
      minWidth.value = '420';
      minWidth.dispatchEvent(new Event('input', { bubbles: true }));
      gap.value = '24';
      gap.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForLayoutReady(surfaces.statusPage);

    const after = await captureSnapshot(surfaces.statusPage, 'status-layout-controls-after-slider');
    const storedSettings = await surfaces.statusPage.evaluate(() => JSON.parse(localStorage.getItem('bellforge.status.layout-settings.v1') || '{}'));

    assert.equal(storedSettings.minCardWidth, 420, 'Minimum card width slider was not persisted');
    assert.equal(storedSettings.gap, 24, 'Card gap slider was not persisted');
    assert.equal(after.container.gap, 24, 'Card gap slider did not trigger an immediate layout reflow');
    assert.notEqual(after.container.columns, before.container.columns, 'Minimum card width slider did not change the responsive layout tracks');

    assertConsoleContains(surfaces.statusConsole, 'slider change', 'status slider console');
    assertConsoleContains(surfaces.statusConsole, 'saveLayout attempt', 'status slider console');
  } finally {
    await surfaces.context.close();
  }
});

test('status auto arrange and reset layout are deterministic and settings runtime uses the unified engine hooks', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'status-layout-auto-reset-controls');

  try {
    const settingsRuntime = await surfaces.settingsPage.evaluate(() => ({
      hasUnifiedClass: document.getElementById('settingsCardGrid')?.classList.contains('fibo-adaptive-grid') === true,
      hasRequestLayout: typeof window.__bellforgeSettingsLayout?.requestLayout === 'function',
      hasSaveLayout: typeof window.__bellforgeSettingsLayout?.saveLayout === 'function',
      hasDirtyInspector: typeof window.__bellforgeSettingsLayout?.isDirty === 'function',
    }));

    assert.equal(settingsRuntime.hasUnifiedClass, true, 'Settings page did not activate the unified adaptive layout class');
    assert.equal(settingsRuntime.hasRequestLayout, true, 'Settings page is missing the unified requestLayout hook');
    assert.equal(settingsRuntime.hasSaveLayout, true, 'Settings page is missing the unified saveLayout hook');
    assert.equal(settingsRuntime.hasDirtyInspector, true, 'Settings page is missing the unified dirty-state hook');

    await forceEnableStatusEditMode(surfaces.statusPage);
    await dragCard(surfaces.statusPage, 'advanced', 'browser-links');
    await surfaces.statusPage.click('#layoutAutoArrange');
    await waitForLayoutReady(surfaces.statusPage);

    const afterAutoArrange = await captureSnapshot(surfaces.statusPage, 'status-layout-controls-after-auto-arrange');
    assert.deepEqual(orderedKeys(afterAutoArrange), DEFAULT_STATUS_ORDER, 'Auto Arrange did not restore the deterministic Fibonacci layout order');

    await dragCard(surfaces.statusPage, 'setup-hero', 'browser-links');
    await surfaces.statusPage.click('#layoutReset');
    await waitForLayoutReady(surfaces.statusPage);

    const afterReset = await captureSnapshot(surfaces.statusPage, 'status-layout-controls-after-reset');
    const storedState = await surfaces.statusPage.evaluate(() => JSON.parse(localStorage.getItem('bellforge.status.fibo-cards.v1') || '{}'));

    assert.deepEqual(orderedKeys(afterReset), DEFAULT_STATUS_ORDER, 'Reset Layout did not restore the default saved order');
    assert.equal(storedState['browser-links']?.order, 0, 'Reset Layout did not persist the default first card');
    assert.equal(storedState['quick-facts']?.order, 5, 'Reset Layout did not persist the default trailing card');

    assertConsoleContains(surfaces.statusConsole, 'auto arrange', 'status auto/reset console');
    assertConsoleContains(surfaces.statusConsole, 'reset layout', 'status auto/reset console');
  } finally {
    await surfaces.context.close();
  }
});