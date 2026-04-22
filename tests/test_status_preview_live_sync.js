const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openPage,
  captureSnapshot,
  waitForLayoutReady,
  dragCard,
  STATUS_PATH,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

async function applyPreviewEdits(previewPage) {
  await previewPage.evaluate(() => {
    const minWidth = document.getElementById('layoutMinWidth');
    const gap = document.getElementById('layoutGap');
    minWidth.value = '420';
    minWidth.dispatchEvent(new Event('input', { bubbles: true }));
    gap.value = '24';
    gap.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForLayoutReady(previewPage);
  await dragCard(previewPage, 'advanced', 'browser-links');
}

function hasRuntimeBootstrapError(entries) {
  return entries.some((entry) => /Unhandled window error|toFixed|TypeError/i.test(entry.text));
}

test('status preview uses remote browser dimensions while the live display uses physical display dimensions, and save publishes updates to live status', async () => {
  const context = await suite.newContext({ width: 2560, height: 1440 });

  try {
    const liveDisplay = await openPage(context, `${STATUS_PATH}?view=display`, 'status-live-display');
    const preview = await openPage(context, `${STATUS_PATH}?view=display&mirror=1&editor=1`, 'status-preview-editor');

    await preview.page.waitForSelector('#layoutSave');
    await waitForLayoutReady(preview.page);
    await waitForLayoutReady(liveDisplay.page);

    const previewBefore = await captureSnapshot(preview.page, 'status-preview-before-save');
    const liveBefore = await captureSnapshot(liveDisplay.page, 'status-live-before-save');

    assert.equal(previewBefore.layoutCache.viewport.source, 'preview-remote-browser');
    assert.equal(liveBefore.layoutCache.viewport.source, 'physical-display');
    assert.ok(previewBefore.layoutCache.viewport.layoutWidth > liveBefore.layoutCache.viewport.layoutWidth, 'Preview did not use the larger remote browser width');
    assert.ok(previewBefore.container.columns >= liveBefore.container.columns, 'Preview did not allow a denser column layout than the live display');

    await applyPreviewEdits(preview.page);
    await preview.page.evaluate(async () => {
      await window.__bellforgeStatusLayout?.saveSharedLayout?.('browser-test-preview-save');
    });

    await liveDisplay.page.waitForFunction(() => {
      const state = window.__bellforgeStatusLayout?.getState?.() || {};
      const gap = Number.parseFloat(getComputedStyle(document.querySelector('.wrap')).getPropertyValue('--bf-masonry-gap') || '0');
      return state.advanced?.order === 0 && gap === 24;
    }, { timeout: 15000 });
    await waitForLayoutReady(liveDisplay.page);

    const previewAfter = await captureSnapshot(preview.page, 'status-preview-after-save');
    const liveAfter = await captureSnapshot(liveDisplay.page, 'status-live-after-save');

    assert.equal(previewAfter.container.gap, 24, 'Preview did not apply the edited card gap immediately');
    assert.equal(liveAfter.container.gap, 24, 'Live display did not pick up the saved card gap');
    assert.equal(liveAfter.state.advanced?.order, 0, 'Live display did not pick up the saved card order');
    assert.equal(liveAfter.layoutCache.viewport.source, 'physical-display');
    assert.equal(hasRuntimeBootstrapError(preview.consoleEntries), false, 'Preview bootstrap emitted a runtime error before edit mode initialized');
  } finally {
    await context.close();
  }
});

test('unsaved preview edits do not leak onto the live display before Save Layout is clicked', async () => {
  const context = await suite.newContext({ width: 2560, height: 1440 });

  try {
    const liveDisplay = await openPage(context, `${STATUS_PATH}?view=display`, 'status-live-unsaved-display');
    const preview = await openPage(context, `${STATUS_PATH}?view=display&mirror=1&editor=1`, 'status-preview-unsaved-editor');

    await preview.page.waitForSelector('#layoutSave');
    await waitForLayoutReady(preview.page);
    await waitForLayoutReady(liveDisplay.page);

    const liveBefore = await captureSnapshot(liveDisplay.page, 'status-live-before-unsaved-preview-edit');

    await applyPreviewEdits(preview.page);

    const previewPendingState = await preview.page.evaluate(() => ({
      saveLabel: document.getElementById('layoutSave')?.textContent?.trim() || '',
      pendingClass: document.getElementById('layoutSave')?.classList.contains('is-pending-save') === true,
      state: window.__bellforgeStatusLayout?.getState?.() || {},
      gap: Number.parseFloat(getComputedStyle(document.querySelector('.wrap')).getPropertyValue('--bf-masonry-gap') || '0'),
    }));

    await liveDisplay.page.waitForTimeout(2500);
    await waitForLayoutReady(liveDisplay.page);
    const liveAfter = await captureSnapshot(liveDisplay.page, 'status-live-after-unsaved-preview-edit');

    assert.equal(previewPendingState.pendingClass, true, 'Preview did not mark the shared layout as pending after local edits');
    assert.equal(previewPendingState.saveLabel, 'Save Layout*', 'Preview save button did not indicate unsaved shared changes');
    assert.equal(previewPendingState.state.advanced?.order, 0, 'Preview drag did not reorder the advanced card before save');
    assert.equal(previewPendingState.gap, 24, 'Preview gap edit did not apply locally before save');
    assert.equal(liveAfter.state.advanced?.order, liveBefore.state.advanced?.order, 'Live display changed before the preview layout was explicitly saved');
    assert.equal(liveAfter.container.gap, liveBefore.container.gap, 'Live display gap changed before Save Layout was clicked');
  } finally {
    await context.close();
  }
});

test('a delayed shared-layout refresh does not overwrite pending preview edits before save', async () => {
  const context = await suite.newContext({ width: 2560, height: 1440 });
  let intercepted = false;
  let markFetchIntercepted = null;
  let releaseDelayedFetch = null;
  const delayedFetchSeen = new Promise((resolve) => {
    markFetchIntercepted = resolve;
  });
  const delayedFetchReleased = new Promise((resolve) => {
    releaseDelayedFetch = resolve;
  });

  await context.route('**/api/display/status-layout', async (route) => {
    if (route.request().method() === 'GET' && !intercepted) {
      intercepted = true;
      const response = await route.fetch();
      const body = await response.text();
      markFetchIntercepted?.();
      await delayedFetchReleased;
      await route.fulfill({ response, body });
      return;
    }
    await route.continue();
  });

  try {
    const preview = await openPage(context, `${STATUS_PATH}?view=display&mirror=1&editor=1`, 'status-preview-delayed-refresh');

    await preview.page.waitForSelector('#layoutSave');
    await waitForLayoutReady(preview.page);
    await delayedFetchSeen;
    await applyPreviewEdits(preview.page);

    const pendingBeforeRelease = await preview.page.evaluate(() => ({
      settings: JSON.parse(localStorage.getItem('bellforge.status.layout-settings.v1') || '{}'),
      state: window.__bellforgeStatusLayout?.getState?.() || {},
      saveLabel: document.getElementById('layoutSave')?.textContent?.trim() || '',
      pendingClass: document.getElementById('layoutSave')?.classList.contains('is-pending-save') === true,
    }));

    releaseDelayedFetch?.();
    await preview.page.waitForTimeout(1000);
    await waitForLayoutReady(preview.page);

    const pendingAfterRelease = await preview.page.evaluate(() => ({
      settings: JSON.parse(localStorage.getItem('bellforge.status.layout-settings.v1') || '{}'),
      state: window.__bellforgeStatusLayout?.getState?.() || {},
      saveLabel: document.getElementById('layoutSave')?.textContent?.trim() || '',
      pendingClass: document.getElementById('layoutSave')?.classList.contains('is-pending-save') === true,
    }));

    assert.equal(pendingBeforeRelease.settings.minCardWidth, 420, 'Preview min-card-width edit was not stored locally before the delayed refresh completed');
    assert.equal(pendingBeforeRelease.settings.gap, 24, 'Preview gap edit was not stored locally before the delayed refresh completed');
    assert.equal(pendingBeforeRelease.state.advanced?.order, 0, 'Preview drag state was not updated before the delayed refresh completed');
    assert.equal(pendingBeforeRelease.pendingClass, true, 'Preview did not mark the shared layout as pending before the delayed refresh completed');
    assert.equal(pendingAfterRelease.settings.minCardWidth, 420, 'A delayed shared-layout response overwrote the preview min-card-width edit');
    assert.equal(pendingAfterRelease.settings.gap, 24, 'A delayed shared-layout response overwrote the preview gap edit');
    assert.equal(pendingAfterRelease.state.advanced?.order, 0, 'A delayed shared-layout response overwrote the preview drag order');
    assert.equal(pendingAfterRelease.pendingClass, true, 'Preview lost its pending-save marker after a delayed shared-layout response');
    assert.equal(pendingAfterRelease.saveLabel, 'Save Layout*', 'Preview save button stopped indicating pending shared changes after a delayed refresh');
    assert.equal(hasRuntimeBootstrapError(preview.consoleEntries), false, 'Preview bootstrap emitted a runtime error during the delayed-refresh scenario');
  } finally {
    await context.close();
  }
});