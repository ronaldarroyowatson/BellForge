const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  waitForLayoutReady,
  countVisibleCards,
  assertCardsRemainInGrid,
  assertCollapseControls,
  assertNoOverlap,
  assertFibonacciRatios,
  assertWeightOrdering,
  simplifyLayout,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

function simplifyDisplayStructure(snapshot) {
  return {
    layoutMode: snapshot.layoutMode,
    columns: snapshot.container.columns,
    gap: snapshot.container.gap,
    cards: snapshot.cards.map((card) => ({
      key: card.key,
      order: card.order,
      colStart: card.colStart,
      colSpan: card.colSpan,
      collapsed: card.collapsed,
    })),
  };
}

async function freezeStatusSurface(page) {
  await page.evaluate(() => {
    for (let timerId = 1; timerId < 10000; timerId += 1) {
      window.clearInterval(timerId);
      window.clearTimeout(timerId);
    }
  });
  await page.evaluate(async () => {
    if (typeof refreshDisplayPreferences === 'function') {
      await refreshDisplayPreferences();
    }
    if (typeof refresh === 'function') {
      await refresh();
    }
    window.__bellforgeStatusLayout?.requestLayout?.('test-freeze');
    window.__bellforgeSettingsLayout?.requestLayout?.('test-freeze');
  });
  await waitForLayoutReady(page);
}

test('default layout stays readable, masonry-packed, and consistent between linked display access and the real status display', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'default-layout');

  try {
    await Promise.all([
      freezeStatusSurface(surfaces.statusPage),
      freezeStatusSurface(surfaces.displayPage),
      freezeStatusSurface(surfaces.settingsPage),
      freezeStatusSurface(surfaces.settingsDisplayPage),
    ]);

    const statusSnapshot = await captureSnapshot(surfaces.statusPage, 'status-default-layout');
    const settingsSnapshot = await captureSnapshot(surfaces.settingsPage, 'settings-default-layout');
    const displaySnapshot = await captureSnapshot(surfaces.displayPage, 'display-default-layout');
    const settingsDisplaySnapshot = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-default-layout');
    recordSnapshotArtifact('default-layout-status', statusSnapshot, surfaces.statusConsole, {
      settingsSnapshot,
      displaySnapshot,
      settingsDisplaySnapshot,
    });

    assert.deepEqual(statusSnapshot.cards.map((card) => card.key), ['browser-links', 'onboarding-qr', 'stats', 'advanced', 'setup-hero', 'quick-facts']);
    assertCardsRemainInGrid(statusSnapshot);
    assertCardsRemainInGrid(settingsSnapshot);
    assertCollapseControls(statusSnapshot, ['setup-hero', 'quick-facts', 'browser-links', 'onboarding-qr', 'stats', 'advanced']);
    assertNoOverlap(statusSnapshot);
    assertNoOverlap(settingsSnapshot);
    assertNoOverlap(settingsDisplaySnapshot);
    assertFibonacciRatios(statusSnapshot);
    assertFibonacciRatios(settingsSnapshot);
    assertFibonacciRatios(settingsDisplaySnapshot);
    assertWeightOrdering(settingsSnapshot);
    assert.equal(settingsSnapshot.cards.every((card) => card.collapsed), true, 'Default settings layout should start fully collapsed');
    assert.ok(countVisibleCards(statusSnapshot) >= 1, 'Default status layout is not readable enough above the fold');
    assert.ok(countVisibleCards(settingsSnapshot) >= 2, 'Default settings layout is not readable enough above the fold');
    assert.deepEqual(simplifyDisplayStructure(settingsDisplaySnapshot), simplifyDisplayStructure(displaySnapshot), 'Linked display access does not match the real status display structure');
  } finally {
    await surfaces.context.close();
  }
});

test('design controls expose layout mode and portrait vs landscape produce different masonry layouts across status, settings, and linked display surfaces', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1600, height: 1000 }, 'layout-mode-defaults');

  try {
    await Promise.all([
      freezeStatusSurface(surfaces.statusPage),
      freezeStatusSurface(surfaces.displayPage),
      freezeStatusSurface(surfaces.settingsPage),
      freezeStatusSurface(surfaces.settingsDisplayPage),
    ]);

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
    const portraitSettingsDisplay = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-portrait-layout-mode');

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
      surfaces.settingsPage.evaluate((payload) => {
        localStorage.setItem('bellforge.design-controls.live.v1', JSON.stringify({ source: 'test', timestamp: Date.now(), payload }));
        pushDesignControlsToForm(payload);
        window.__bellforgeSettingsLayout?.recompute?.();
      }, landscapePayload),
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
      surfaces.settingsDisplayPage.evaluate((payload) => {
        localStorage.setItem('bellforge.design-controls.live.v1', JSON.stringify({ source: 'test', timestamp: Date.now(), payload }));
        applyDesignControls(payload);
        window.__bellforgeStatusLayout?.recompute?.();
      }, landscapePayload),
    ]);
    await Promise.all([
      waitForLayoutReady(surfaces.statusPage),
      waitForLayoutReady(surfaces.displayPage),
      waitForLayoutReady(surfaces.settingsPage),
      waitForLayoutReady(surfaces.settingsDisplayPage),
    ]);

    await Promise.all([
      surfaces.settingsPage.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
      surfaces.statusPage.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
      surfaces.displayPage.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
      surfaces.settingsDisplayPage.waitForFunction(() => document.documentElement.dataset.designLayoutMode === 'landscape'),
    ]);

    const landscapeStatus = await captureSnapshot(surfaces.statusPage, 'status-landscape-layout-mode');
    const landscapeSettings = await captureSnapshot(surfaces.settingsPage, 'settings-landscape-layout-mode');
    const landscapeDisplay = await captureSnapshot(surfaces.displayPage, 'display-landscape-layout-mode');
    const landscapeSettingsDisplay = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-landscape-layout-mode');

    recordSnapshotArtifact('layout-mode-portrait-landscape', portraitStatus, surfaces.statusConsole, {
      portraitSettings,
      portraitDisplay,
      portraitSettingsDisplay,
      landscapeStatus,
      landscapeSettings,
      landscapeDisplay,
      landscapeSettingsDisplay,
    });

    assert.notDeepEqual(simplifyLayout(landscapeStatus), simplifyLayout(portraitStatus), 'Status layout did not change between portrait and landscape mode');
    assert.notDeepEqual(simplifyLayout(landscapeSettings), simplifyLayout(portraitSettings), 'Settings layout did not change between portrait and landscape mode');
    assert.notDeepEqual(simplifyLayout(landscapeSettingsDisplay), simplifyLayout(portraitSettingsDisplay), 'Linked display layout did not change between portrait and landscape mode');
    assert.deepEqual(simplifyDisplayStructure(landscapeSettingsDisplay), simplifyDisplayStructure(landscapeDisplay), 'Linked display landscape structure does not match the live display view');
  } finally {
    await surfaces.context.close();
  }
});