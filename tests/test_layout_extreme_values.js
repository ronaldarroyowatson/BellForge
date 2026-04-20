const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  waitForLayoutReady,
  runScratchScenario,
  assertNoOverlap,
  assertFibonacciRatios,
  assertExpectedColumns,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('extreme viewport, content, and token values still keep the layout readable and collision-free', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 480, height: 320 }, 'layout-extreme-values');

  try {
    const tinyStatus = await captureSnapshot(surfaces.statusPage, 'status-tiny-viewport');
    const tinySettings = await captureSnapshot(surfaces.settingsPage, 'settings-tiny-viewport');
    const tinySettingsDisplay = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-tiny-viewport');
    recordSnapshotArtifact('tiny-viewport-layouts', tinyStatus, surfaces.statusConsole, {
      settingsSnapshot: tinySettings,
      settingsDisplaySnapshot: tinySettingsDisplay,
    });
    assertNoOverlap(tinyStatus);
    assertNoOverlap(tinySettings);
    assertNoOverlap(tinySettingsDisplay);
    assertExpectedColumns(tinyStatus, 1);
    assertExpectedColumns(tinySettings, 1);

    await surfaces.statusPage.setViewportSize({ width: 2560, height: 1440 });
    await surfaces.settingsPage.setViewportSize({ width: 2560, height: 1440 });
    await surfaces.displayPage.setViewportSize({ width: 2560, height: 1440 });
    await waitForLayoutReady(surfaces.statusPage);
    await waitForLayoutReady(surfaces.settingsPage);
    await waitForLayoutReady(surfaces.displayPage);
    await waitForLayoutReady(surfaces.settingsDisplayPage);

    const largeStatus = await captureSnapshot(surfaces.statusPage, 'status-large-viewport');
    const largeSettings = await captureSnapshot(surfaces.settingsPage, 'settings-large-viewport');
    recordSnapshotArtifact('large-viewport-layouts', largeStatus, surfaces.statusConsole, {
      settingsSnapshot: largeSettings,
    });
    assertNoOverlap(largeStatus);
    assertNoOverlap(largeSettings);
    assertFibonacciRatios(largeStatus);
    assertFibonacciRatios(largeSettings);
    assert.ok(largeStatus.container.columns >= tinyStatus.container.columns, 'Large status viewport unexpectedly reduced the masonry track count');
    assert.ok(largeSettings.container.columns >= tinySettings.container.columns, 'Large settings viewport unexpectedly reduced the masonry track count');

    const longContentSnapshot = await runScratchScenario(surfaces.statusPage, {
      kind: 'scratch-long-content-layout',
      mode: 'status',
      cards: [
        { key: 'hero-card', title: 'Hero Card', content: 'Extremely long content '.repeat(320), layoutPriority: 9, graphic: true },
        { key: 'details-card', title: 'Details Card', content: 'Diagnostic payload '.repeat(180), layoutPriority: 7 },
        { key: 'logs-card', title: 'Logs Card', content: 'L '.repeat(800), layoutPriority: 5 },
      ],
      tracks: 10,
      maxPerRow: 3,
      storageKey: 'bellforge.test.scratch.long-content',
      containerWidth: 1440,
    });
    recordSnapshotArtifact('scratch-long-content-layout', longContentSnapshot, surfaces.statusConsole);
    assertNoOverlap(longContentSnapshot);
    assert.equal(longContentSnapshot.cards.length, 3, 'Extreme-content layout dropped cards');
    assert.ok(longContentSnapshot.cards.every((card) => card.rect.height > card.titlebarHeight), 'Extreme-content layout collapsed usable card content');

    const clampedTokens = await surfaces.settingsPage.evaluate(() => {
      if (typeof normalizeDesignControls !== 'function' || typeof applyDesignControls !== 'function') {
        throw new Error('Settings design control helpers are not available');
      }
      const high = normalizeDesignControls({ ui_scale: 999, font_scale: 999, card_radius_px: 999, shadow_intensity: 999, status_page_scale: 999 });
      applyDesignControls(high);
      const low = normalizeDesignControls({ ui_scale: -999, font_scale: -999, card_radius_px: -999, shadow_intensity: -999, status_page_scale: -999 });
      return { high, low };
    });
    assert.equal(clampedTokens.high.ui_scale <= 1.2, true, 'Extreme high UI scale was not clamped');
    assert.equal(clampedTokens.low.ui_scale >= 0.8, true, 'Extreme low UI scale was not clamped');

    await waitForLayoutReady(surfaces.settingsPage);
    const settingsAfterExtremeTokens = await captureSnapshot(surfaces.settingsPage, 'settings-after-extreme-tokens');
    recordSnapshotArtifact('settings-after-extreme-tokens', settingsAfterExtremeTokens, surfaces.settingsConsole);
    assertNoOverlap(settingsAfterExtremeTokens);
  } finally {
    await surfaces.context.close();
  }
});