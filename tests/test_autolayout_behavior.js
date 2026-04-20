const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  broadcastStatusLayoutCommand,
  captureSnapshot,
  recordSnapshotArtifact,
  waitForLayoutReady,
  assertNoOverlap,
  assertFibonacciRatios,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

function orderedKeys(snapshot) {
  return snapshot.cards.map((card) => card.key);
}

test('auto-arrange keeps status, settings, and linked display surfaces healthy and in sync', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'autolayout-behavior');

  try {
    await broadcastStatusLayoutCommand(surfaces.settingsPage, 'auto-arrange');
    await surfaces.settingsPage.evaluate(() => {
      window.__bellforgeSettingsLayout?.autoArrange?.();
    });
    await waitForLayoutReady(surfaces.settingsDisplayPage);
    await waitForLayoutReady(surfaces.displayPage);
    await waitForLayoutReady(surfaces.statusPage);
    await waitForLayoutReady(surfaces.settingsPage);

    const statusAfterAuto = await captureSnapshot(surfaces.statusPage, 'status-after-auto-arrange');
    const settingsDisplayAfterAuto = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-after-auto-arrange');
    const displayAfterAuto = await captureSnapshot(surfaces.displayPage, 'display-after-auto-arrange');
    const settingsAfterAuto = await captureSnapshot(surfaces.settingsPage, 'settings-after-auto-arrange');
    recordSnapshotArtifact('status-after-auto-arrange', statusAfterAuto, surfaces.statusConsole, {
      settingsDisplaySnapshot: settingsDisplayAfterAuto,
      displaySnapshot: displayAfterAuto,
      settingsSnapshot: settingsAfterAuto,
    });

    assertNoOverlap(statusAfterAuto);
    assertNoOverlap(settingsDisplayAfterAuto);
    assertNoOverlap(settingsAfterAuto);
    assertFibonacciRatios(statusAfterAuto);
    assertFibonacciRatios(settingsDisplayAfterAuto);
    assertFibonacciRatios(settingsAfterAuto);
    assert.equal(settingsDisplayAfterAuto.container.columns, displayAfterAuto.container.columns, 'Linked display auto-arrange changed column counts inconsistently');
    assert.deepEqual(orderedKeys(settingsDisplayAfterAuto), orderedKeys(displayAfterAuto), 'Linked display auto-arrange changed the card registry or order inconsistently');
    assert.deepEqual(orderedKeys(statusAfterAuto), orderedKeys(displayAfterAuto), 'Status and linked display surfaces diverged after auto-arrange');
    assert.ok(orderedKeys(settingsAfterAuto).length > 0, 'Settings auto-arrange removed all cards from the layout');
  } finally {
    await surfaces.context.close();
  }
});