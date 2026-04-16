const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  countVisibleCards,
  assertCardsRemainInGrid,
  assertCollapseControls,
  assertNoOverlap,
  assertFibonacciRatios,
  assertWeightOrdering,
  simplifyLayout,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('default layout stays readable, Fibonacci-packed, and identical between preview and real status display', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'default-layout');

  try {
    const statusSnapshot = await captureSnapshot(surfaces.statusPage, 'status-default-layout');
    const settingsSnapshot = await captureSnapshot(surfaces.settingsPage, 'settings-default-layout');
    const displaySnapshot = await captureSnapshot(surfaces.displayPage, 'display-default-layout');
    const previewSnapshot = await captureSnapshot(surfaces.previewFrame, 'preview-default-layout');
    recordSnapshotArtifact('default-layout-status', statusSnapshot, surfaces.statusConsole, {
      settingsSnapshot,
      displaySnapshot,
      previewSnapshot,
    });

    assert.deepEqual(statusSnapshot.cards.map((card) => card.key), ['setup-hero', 'quick-facts', 'browser-links', 'onboarding-qr', 'stats', 'advanced']);
    assertCardsRemainInGrid(statusSnapshot);
    assertCardsRemainInGrid(settingsSnapshot);
    assertCollapseControls(statusSnapshot, ['setup-hero', 'quick-facts', 'browser-links', 'onboarding-qr', 'stats', 'advanced']);
    assertNoOverlap(statusSnapshot);
    assertNoOverlap(settingsSnapshot);
    assertNoOverlap(previewSnapshot);
    assertFibonacciRatios(statusSnapshot);
    assertFibonacciRatios(settingsSnapshot);
    assertFibonacciRatios(previewSnapshot);
    assertWeightOrdering(settingsSnapshot);
    assert.equal(settingsSnapshot.cards.every((card) => card.collapsed), true, 'Default settings layout should start fully collapsed');
    assert.ok(countVisibleCards(statusSnapshot) >= 3, 'Default status layout is not readable enough above the fold');
    assert.ok(countVisibleCards(settingsSnapshot) >= 2, 'Default settings layout is not readable enough above the fold');
    assert.deepEqual(simplifyLayout(previewSnapshot), simplifyLayout(displaySnapshot), 'Default preview layout does not match the real status display page');
  } finally {
    await surfaces.context.close();
  }
});

test('design controls expose layout mode and portrait vs landscape produce different Fibonacci layouts across status, settings, and preview', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1600, height: 1000 }, 'layout-mode-defaults');

  try {
    const layoutModeInfo = await surfaces.settingsPage.evaluate(() => {
      const control = document.getElementById('designLayoutMode');
      return {
        exists: Boolean(control),
        value: control ? control.value : null,
        options: control ? Array.from(control.options).map((option) => option.value) : [],
      };
    });

    assert.equal(layoutModeInfo.exists, true, 'Design Control System is missing the Layout Mode control');
    assert.equal(layoutModeInfo.value, 'portrait', 'Layout Mode should default to portrait');
    assert.deepEqual(layoutModeInfo.options, ['portrait', 'landscape'], 'Layout Mode options are incomplete');

    const portraitStatus = await captureSnapshot(surfaces.statusPage, 'status-portrait-layout-mode');
    const portraitSettings = await captureSnapshot(surfaces.settingsPage, 'settings-portrait-layout-mode');
    const portraitDisplay = await captureSnapshot(surfaces.displayPage, 'display-portrait-layout-mode');
    const portraitPreview = await captureSnapshot(surfaces.previewFrame, 'preview-portrait-layout-mode');

    await surfaces.settingsPage.evaluate(() => {
      if (typeof pushDesignControlsToForm !== 'function') {
        throw new Error('pushDesignControlsToForm is not available');
      }
      pushDesignControlsToForm({
        theme: 'warm',
        font_scale: 1,
        ui_scale: 1,
        card_radius_px: 14,
        shadow_intensity: 1,
        status_page_scale: 0.92,
        layout_mode: 'landscape',
      });
    });
    const landscapePayload = {
      theme: 'warm',
      font_scale: 1,
      ui_scale: 1,
      card_radius_px: 14,
      shadow_intensity: 1,
      status_page_scale: 0.92,
      layout_mode: 'landscape',
    };
    await Promise.all([
      surfaces.statusPage.evaluate((payload) => {
        localStorage.setItem('bellforge.design-controls.live.v1', JSON.stringify({ source: 'test', timestamp: Date.now(), payload }));
        applyDesignControls(payload);
        window.__bellforgeStatusLayout?.recompute?.();
      }, landscapePayload),
      surfaces.displayPage.evaluate((payload) => {
        localStorage.setItem('bellforge.design-controls.live.v1', JSON.stringify({ source: 'test', timestamp: Date.now(), payload }));
        applyDesignControls(payload);
        window.__bellforgeStatusLayout?.recompute?.();
      }, landscapePayload),
      surfaces.previewFrame.evaluate((payload) => {
        localStorage.setItem('bellforge.design-controls.live.v1', JSON.stringify({ source: 'test', timestamp: Date.now(), payload }));
        applyDesignControls(payload);
        window.__bellforgeStatusLayout?.recompute?.();
      }, landscapePayload),
    ]);
    await Promise.all([
      surfaces.statusPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
      surfaces.displayPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
      surfaces.previewFrame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
    ]);

    await Promise.all([
      surfaces.statusPage.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
      surfaces.displayPage.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
      surfaces.previewFrame.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
    ]);

    const landscapeStatus = await captureSnapshot(surfaces.statusPage, 'status-landscape-layout-mode');
    const landscapeSettings = await captureSnapshot(surfaces.settingsPage, 'settings-landscape-layout-mode');
    const landscapeDisplay = await captureSnapshot(surfaces.displayPage, 'display-landscape-layout-mode');
    const landscapePreview = await captureSnapshot(surfaces.previewFrame, 'preview-landscape-layout-mode');

    recordSnapshotArtifact('layout-mode-portrait-landscape', portraitStatus, surfaces.statusConsole, {
      portraitSettings,
      portraitDisplay,
      portraitPreview,
      landscapeStatus,
      landscapeSettings,
      landscapeDisplay,
      landscapePreview,
    });

    assert.notDeepEqual(simplifyLayout(landscapeStatus), simplifyLayout(portraitStatus), 'Status layout did not change between portrait and landscape mode');
    assert.notDeepEqual(simplifyLayout(landscapeSettings), simplifyLayout(portraitSettings), 'Settings layout did not change between portrait and landscape mode');
    assert.notDeepEqual(simplifyLayout(landscapePreview), simplifyLayout(portraitPreview), 'Preview layout did not change between portrait and landscape mode');
    assert.deepEqual(simplifyLayout(landscapePreview), simplifyLayout(landscapeDisplay), 'Preview landscape layout does not match the live display view');
  } finally {
    await surfaces.context.close();
  }
});