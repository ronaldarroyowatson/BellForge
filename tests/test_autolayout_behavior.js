const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  waitForLayoutReady,
  clickElement,
  dragCard,
  setCardCollapsed,
  assertNoOverlap,
  assertFibonacciRatios,
  assertMovement,
  assertWhitespaceImproves,
  assertConsoleContains,
  simplifyLayout,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

async function waitForCardOrder(target, earlierKey, laterKey) {
  await target.waitForFunction(({ earlierKey, laterKey }) => {
    const earlier = document.querySelector(`[data-card-key="${earlierKey}"]`);
    const later = document.querySelector(`[data-card-key="${laterKey}"]`);
    const earlierOrder = Number(earlier?.dataset.fiboOrder || Number.NaN);
    const laterOrder = Number(later?.dataset.fiboOrder || Number.NaN);
    return Number.isFinite(earlierOrder) && Number.isFinite(laterOrder) && earlierOrder < laterOrder;
  }, { earlierKey, laterKey });
}

test('auto-arrange visibly rearranges cards and keeps status, settings, and preview in sync', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'autolayout-behavior');

  try {
    await dragCard(surfaces.statusPage, 'advanced', 'browser-links');
    await waitForCardOrder(surfaces.statusPage, 'advanced', 'browser-links');
    const statusBeforeAuto = await captureSnapshot(surfaces.statusPage, 'status-before-auto-arrange');
    recordSnapshotArtifact('status-before-auto-arrange', statusBeforeAuto, surfaces.statusConsole);

    await clickElement(surfaces.settingsPage, '#designStatusModalArrange');
    await waitForCardOrder(surfaces.statusPage, 'browser-links', 'advanced');
    await waitForLayoutReady(surfaces.previewFrame);
    await waitForLayoutReady(surfaces.displayPage);
    await waitForLayoutReady(surfaces.statusPage);

    const statusAfterAuto = await captureSnapshot(surfaces.statusPage, 'status-after-auto-arrange');
    const previewAfterAuto = await captureSnapshot(surfaces.previewFrame, 'preview-after-auto-arrange');
    const displayAfterAuto = await captureSnapshot(surfaces.displayPage, 'display-after-auto-arrange');
    recordSnapshotArtifact('status-after-auto-arrange', statusAfterAuto, surfaces.statusConsole, {
      previewSnapshot: previewAfterAuto,
      displaySnapshot: displayAfterAuto,
    });

    assert.notDeepEqual(simplifyLayout(statusAfterAuto), simplifyLayout(statusBeforeAuto), 'Status auto-arrange did not visibly rearrange cards');
    assert.deepEqual(simplifyLayout(previewAfterAuto), simplifyLayout(displayAfterAuto), 'Preview auto-arrange drifted from the real status display page');
    assertNoOverlap(statusAfterAuto);
    assertNoOverlap(previewAfterAuto);
    assertFibonacciRatios(statusAfterAuto);
    assertFibonacciRatios(previewAfterAuto);
    assertMovement(statusBeforeAuto, statusAfterAuto, { requireHorizontal: true, requireVertical: true });

    await setCardCollapsed(surfaces.statusPage, 'stats', true);
    const statusCollapsed = await captureSnapshot(surfaces.statusPage, 'status-before-collapsed-auto-arrange');
    recordSnapshotArtifact('status-before-collapsed-auto-arrange', statusCollapsed, surfaces.statusConsole);

    await clickElement(surfaces.settingsPage, '#designStatusModalArrange');
    await waitForLayoutReady(surfaces.previewFrame);
    await waitForLayoutReady(surfaces.displayPage);
    await waitForLayoutReady(surfaces.statusPage);

    const statusAfterCollapsedAuto = await captureSnapshot(surfaces.statusPage, 'status-after-collapsed-auto-arrange');
    const previewAfterCollapsedAuto = await captureSnapshot(surfaces.previewFrame, 'preview-after-collapsed-auto-arrange');
    recordSnapshotArtifact('status-after-collapsed-auto-arrange', statusAfterCollapsedAuto, surfaces.statusConsole, {
      previewSnapshot: previewAfterCollapsedAuto,
    });

    assertNoOverlap(statusAfterCollapsedAuto);
    assertNoOverlap(previewAfterCollapsedAuto);
    assertFibonacciRatios(statusAfterCollapsedAuto);
    assertWhitespaceImproves(statusCollapsed, statusAfterCollapsedAuto, 'status auto-arrange collapse reflow', 0.05);

    await dragCard(surfaces.settingsPage, 'logs', 'network');
    await waitForCardOrder(surfaces.settingsPage, 'logs', 'network');
    const settingsBeforeAuto = await captureSnapshot(surfaces.settingsPage, 'settings-before-auto-arrange');
    recordSnapshotArtifact('settings-before-auto-arrange', settingsBeforeAuto, surfaces.settingsConsole);

    await surfaces.settingsPage.evaluate(() => {
      window.__bellforgeSettingsLayout?.autoArrange?.();
    });
    await waitForCardOrder(surfaces.settingsPage, 'network', 'logs');
    await waitForLayoutReady(surfaces.settingsPage);

    const settingsAfterAuto = await captureSnapshot(surfaces.settingsPage, 'settings-after-auto-arrange');
    recordSnapshotArtifact('settings-after-auto-arrange', settingsAfterAuto, surfaces.settingsConsole);

    assert.notDeepEqual(simplifyLayout(settingsAfterAuto), simplifyLayout(settingsBeforeAuto), 'Settings auto-arrange did not visibly rearrange cards');
    assertNoOverlap(settingsAfterAuto);
    assertFibonacciRatios(settingsAfterAuto);
    assertMovement(settingsBeforeAuto, settingsAfterAuto, { requireHorizontal: true, requireVertical: true });

    assertConsoleContains(surfaces.settingsConsole, 'auto-arrange events', 'settings auto-arrange console');
    assertConsoleContains(surfaces.statusConsole, 'auto-arrange events', 'status auto-arrange console');
  } finally {
    await surfaces.context.close();
  }
});