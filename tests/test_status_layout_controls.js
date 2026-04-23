const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openPage,
  captureSnapshot,
  dragCard,
  waitForLayoutReady,
  assertConsoleContains,
  STATUS_PATH,
  SETTINGS_PATH,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();
const DEFAULT_STATUS_ORDER = ['browser-links', 'onboarding-qr', 'stats', 'advanced', 'setup-hero', 'quick-facts'];

function orderedKeys(snapshot) {
  return snapshot.cards.map((card) => card.key);
}

async function forceEnableStatusEditMode(page) {
  await page.waitForSelector('#layoutSave');
  await page.evaluate(() => {
    window.__bellforgeStatusLayout?.enableEditMode?.();
  });
  await page.waitForFunction(() => {
    const saveButton = document.getElementById('layoutSave');
    const handle = document.querySelector('[data-card-key="advanced"] .card-titlebar');
    return Boolean(saveButton) && handle?.getAttribute('draggable') === 'true';
  });
  await waitForLayoutReady(page);
}

test('status edit mode drag updates order and persists layout state', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const preview = await openPage(context, `${STATUS_PATH}?view=display&mirror=1&editor=1`, 'status-layout-drag-controls-preview');
    const liveDisplay = await openPage(context, `${STATUS_PATH}?view=display`, 'status-layout-drag-controls-live');

    await forceEnableStatusEditMode(preview.page);

    const beforeDrag = await captureSnapshot(preview.page, 'status-layout-controls-before-drag');
    await dragCard(preview.page, 'advanced', 'browser-links');
    const afterDrag = await captureSnapshot(preview.page, 'status-layout-controls-after-drag');
    const pendingState = await preview.page.evaluate(() => ({
      saveLabel: document.getElementById('layoutSave')?.textContent?.trim() || '',
      pendingClass: document.getElementById('layoutSave')?.classList.contains('is-pending-save') === true,
      state: window.__bellforgeStatusLayout?.getState?.() || {},
    }));

    await preview.page.evaluate(async () => {
      await window.__bellforgeStatusLayout?.saveSharedLayout?.('status-layout-drag-controls');
    });
    const persistedState = await preview.page.evaluate(async () => {
      const response = await fetch('/api/display/status-layout', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const layout = await response.json();
      return layout.cards || {};
    });

    assert.deepEqual(orderedKeys(beforeDrag), DEFAULT_STATUS_ORDER, 'Status page did not start from the expected default order');
    assert.deepEqual(
      orderedKeys(afterDrag),
      ['advanced', 'browser-links', 'onboarding-qr', 'stats', 'setup-hero', 'quick-facts'],
      'Edit-mode drag did not update the in-memory layout order deterministically',
    );
    assert.equal(pendingState.pendingClass, true, 'Preview drag did not mark the shared layout as pending');
    assert.equal(pendingState.saveLabel, 'Save Layout*', 'Preview drag did not show a pending shared save');
    assert.equal(pendingState.state.advanced?.order, 0, 'Preview drag did not update the pending shared layout state');
    assert.equal(persistedState.advanced?.order, 0, 'Dragged card order was not persisted to shared status layout storage');
    assert.equal(persistedState['browser-links']?.order, 1, 'Target card order was not persisted to shared status layout storage');

    assertConsoleContains(preview.consoleEntries, 'edit mode enabled', 'status drag console');
    assertConsoleContains(preview.consoleEntries, 'drag start', 'status drag console');
    assertConsoleContains(preview.consoleEntries, 'drag end', 'status drag console');
    assertConsoleContains(preview.consoleEntries, 'layout save attempt', 'status drag console');
  } finally {
    await context.close();
  }
});

test('status layout sliders trigger immediate reflow and save the updated settings', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const preview = await openPage(context, `${STATUS_PATH}?view=display&mirror=1&editor=1`, 'status-layout-slider-controls-preview');
    const liveDisplay = await openPage(context, `${STATUS_PATH}?view=display`, 'status-layout-slider-controls-live');

    await forceEnableStatusEditMode(preview.page);
    const before = await captureSnapshot(preview.page, 'status-layout-controls-before-slider');

    await preview.page.evaluate(() => {
      const minWidth = document.getElementById('layoutMinWidth');
      const gap = document.getElementById('layoutGap');
      minWidth.value = '420';
      minWidth.dispatchEvent(new Event('input', { bubbles: true }));
      gap.value = '24';
      gap.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForLayoutReady(preview.page);

    const after = await captureSnapshot(preview.page, 'status-layout-controls-after-slider');
    const storedSettings = await preview.page.evaluate(() => JSON.parse(localStorage.getItem('bellforge.status.layout-settings.v1') || '{}'));
    const pendingState = await preview.page.evaluate(() => ({
      saveLabel: document.getElementById('layoutSave')?.textContent?.trim() || '',
      pendingClass: document.getElementById('layoutSave')?.classList.contains('is-pending-save') === true,
    }));

    const saveResult = await preview.page.evaluate(async () => window.__bellforgeStatusLayout?.saveSharedLayout?.('status-layout-slider-controls'));
    assert.equal(saveResult?.min_card_width, 420, 'Shared slider save did not publish min-card width to backend status layout storage');
    assert.equal(saveResult?.card_gap, 24, 'Shared slider save did not publish card gap to backend status layout storage');

    await liveDisplay.page.waitForFunction(() => {
      const gap = Number.parseFloat(getComputedStyle(document.querySelector('.wrap')).getPropertyValue('--bf-masonry-gap') || '0');
      return gap === 24;
    }, { timeout: 30000 });
    const liveAfter = await captureSnapshot(liveDisplay.page, 'status-layout-controls-live-after-slider-save');

    assert.equal(storedSettings.minCardWidth, 420, 'Minimum card width slider was not persisted');
    assert.equal(storedSettings.gap, 24, 'Card gap slider was not persisted');
    assert.equal(after.container.gap, 24, 'Card gap slider did not trigger an immediate layout reflow');
    assert.notEqual(after.container.columns, before.container.columns, 'Minimum card width slider did not change the responsive layout tracks');
    assert.equal(pendingState.pendingClass, true, 'Slider edits did not mark the shared layout as pending');
    assert.equal(pendingState.saveLabel, 'Save Layout*', 'Slider edits did not show a pending shared save');
    assert.equal(liveAfter.container.gap, 24, 'Saved slider settings did not propagate to the live display');

    assertConsoleContains(preview.consoleEntries, 'slider change', 'status slider console');
    assertConsoleContains(preview.consoleEntries, 'layout save attempt', 'status slider console');
  } finally {
    await context.close();
  }
});

test('status auto arrange and reset layout are deterministic and settings runtime uses the unified engine hooks', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settingsPage = await openPage(context, SETTINGS_PATH, 'status-layout-auto-reset-controls-settings');
    const preview = await openPage(context, `${STATUS_PATH}?view=display&mirror=1&editor=1`, 'status-layout-auto-reset-controls-preview');

    const settingsRuntime = await settingsPage.page.evaluate(() => ({
      hasUnifiedClass: document.getElementById('settingsCardGrid')?.classList.contains('fibo-adaptive-grid') === true,
      hasRequestLayout: typeof window.__bellforgeSettingsLayout?.requestLayout === 'function',
      hasSaveLayout: typeof window.__bellforgeSettingsLayout?.saveLayout === 'function',
      hasDirtyInspector: typeof window.__bellforgeSettingsLayout?.isDirty === 'function',
    }));

    assert.equal(settingsRuntime.hasUnifiedClass, true, 'Settings page did not activate the unified adaptive layout class');
    assert.equal(settingsRuntime.hasRequestLayout, true, 'Settings page is missing the unified requestLayout hook');
    assert.equal(settingsRuntime.hasSaveLayout, true, 'Settings page is missing the unified saveLayout hook');
    assert.equal(settingsRuntime.hasDirtyInspector, true, 'Settings page is missing the unified dirty-state hook');

    await forceEnableStatusEditMode(preview.page);
    await dragCard(preview.page, 'advanced', 'browser-links');
    await preview.page.click('#layoutAutoArrange');
    await preview.page.waitForTimeout(750);
    await waitForLayoutReady(preview.page);

    const afterAutoArrange = await captureSnapshot(preview.page, 'status-layout-controls-after-auto-arrange');
    assert.notDeepEqual(orderedKeys(afterAutoArrange), ['advanced', 'browser-links', 'onboarding-qr', 'stats', 'setup-hero', 'quick-facts'], 'Auto Arrange was a no-op after the preview layout changed');

    await dragCard(preview.page, 'setup-hero', 'browser-links');
    await preview.page.click('#layoutAutoArrange');
    await preview.page.waitForTimeout(750);
    await waitForLayoutReady(preview.page);

    const secondAutoArrange = await captureSnapshot(preview.page, 'status-layout-controls-after-second-auto-arrange');
    assert.deepEqual(orderedKeys(secondAutoArrange), orderedKeys(afterAutoArrange), 'Auto Arrange did not produce a deterministic order across repeated runs');

    await dragCard(preview.page, 'setup-hero', 'browser-links');
    await preview.page.click('#layoutReset');
    await preview.page.waitForTimeout(750);
    await waitForLayoutReady(preview.page);

    const afterReset = await captureSnapshot(preview.page, 'status-layout-controls-after-reset');
    const previewState = await preview.page.evaluate(() => window.__bellforgeStatusLayout?.getState?.() || {});

    assert.deepEqual(orderedKeys(afterReset), DEFAULT_STATUS_ORDER, 'Reset Layout did not restore the default saved order');
    assert.equal(previewState['browser-links']?.order, 0, 'Reset Layout did not restore the default first card in preview state');
    assert.equal(previewState['quick-facts']?.order, 5, 'Reset Layout did not restore the default trailing card in preview state');

    assertConsoleContains(preview.consoleEntries, 'auto-arrange', 'status auto/reset console');
    assertConsoleContains(preview.consoleEntries, 'reset layout', 'status auto/reset console');
  } finally {
    await context.close();
  }
});