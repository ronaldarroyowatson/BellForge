const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openPage,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  waitForLayoutReady,
  runScratchScenario,
  assertNoOverlap,
  assertFibonacciRatios,
  assertSpacingBounds,
  assertSpacing,
  collectSpacingMetrics,
  STATUS_PATH,
  SETTINGS_PATH,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('collapsed cards honor spacing tokens and do not balloon because of grid row gaps', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const statusSurface = await openPage(context, STATUS_PATH, 'gap-regression-status');
    const settingsSurface = await openPage(context, SETTINGS_PATH, 'gap-regression-settings');

    const statusScratch = await runScratchScenario(statusSurface.page, {
      kind: 'scratch-status-gap-regression',
      mode: 'status',
      cards: [
        { key: 'hero', title: 'Hero', content: 'Primary content '.repeat(60), layoutPriority: 9, graphic: true },
        { key: 'browser-links', title: 'Browser Links', content: 'Link content '.repeat(40), layoutPriority: 7 },
        { key: 'advanced', title: 'Advanced Diagnostics', content: 'Details '.repeat(30), layoutPriority: 4 },
      ],
      collapsedKeys: ['browser-links', 'advanced'],
      tracks: 10,
      maxPerRow: 3,
      storageKey: 'bellforge.test.scratch.status-gap-regression',
      containerWidth: 1240,
    });
    const settingsScratch = await runScratchScenario(settingsSurface.page, {
      kind: 'scratch-settings-gap-regression',
      mode: 'settings',
      cards: [
        { key: 'network', title: 'Network Settings', content: 'Network '.repeat(28), layoutPriority: 8 },
        { key: 'display-pipeline', title: 'Display Pipeline', content: 'Display '.repeat(38), layoutPriority: 9 },
        { key: 'logs', title: 'Debug Service & Logger', content: 'Logs '.repeat(120), layoutPriority: 4 },
      ],
      collapsedKeys: ['network', 'logs'],
      tracks: 10,
      maxPerRow: 3,
      storageKey: 'bellforge.test.scratch.settings-gap-regression',
      containerWidth: 1180,
    });

    recordSnapshotArtifact('scratch-status-gap-regression', statusScratch, statusSurface.consoleEntries, {
      spacing: collectSpacingMetrics(statusScratch),
    });
    recordSnapshotArtifact('scratch-settings-gap-regression', settingsScratch, settingsSurface.consoleEntries, {
      spacing: collectSpacingMetrics(settingsScratch),
    });

    const collapsedStatusCards = statusScratch.cards.filter((card) => card.collapsed);
    const collapsedSettingsCards = settingsScratch.cards.filter((card) => card.collapsed);

    assert.ok(collapsedStatusCards.length >= 2, 'Status scratch regression did not collapse the expected cards');
    assert.ok(collapsedSettingsCards.length >= 2, 'Settings scratch regression did not collapse the expected cards');

    collapsedStatusCards.forEach((card) => {
      assert.ok(
        card.rect.height <= statusScratch.container.gap + 64,
        `Status collapsed card ${card.key} inflated to ${card.rect.height}px with gap ${statusScratch.container.gap}px`
      );
    });
    collapsedSettingsCards.forEach((card) => {
      assert.ok(
        card.rect.height <= settingsScratch.container.gap + 64,
        `Settings collapsed card ${card.key} inflated to ${card.rect.height}px with gap ${settingsScratch.container.gap}px`
      );
    });

    assertSpacingBounds(statusScratch, {
      maxVerticalGap: Math.max(statusScratch.container.gap * 2, 18),
      maxHorizontalGap: Math.max(statusScratch.container.gap + 4, 12),
    });
    assertSpacingBounds(settingsScratch, {
      maxVerticalGap: Math.max(settingsScratch.container.gap * 2, 18),
      maxHorizontalGap: Math.max(settingsScratch.container.gap + 4, 12),
    });
  } finally {
    await context.close();
  }
});

test('spacing and overlap stay within bounds across status, settings, preview, and token-driven reflow', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1600, height: 1000 }, 'spacing-overlap');

  try {
    for (const [label, target, consoleEntries] of [
      ['status-default', surfaces.statusPage, surfaces.statusConsole],
      ['settings-default', surfaces.settingsPage, surfaces.settingsConsole],
      ['preview-default', surfaces.previewFrame, surfaces.previewConsole],
    ]) {
      const snapshot = await captureSnapshot(target, label);
      recordSnapshotArtifact(label, snapshot, consoleEntries);
      assertNoOverlap(snapshot);
      assertFibonacciRatios(snapshot);
      assertSpacing(snapshot, { minVisibleCards: 2 });
      assertSpacingBounds(snapshot, {
        maxHorizontalGap: Math.max(snapshot.container.gap + 24, 32),
        minHorizontalGap: 0,
        maxUnusedAreaRatio: 0.82,
      });
      assert.ok(snapshot.document.scrollWidth <= snapshot.viewport.width + 32, `${label}: horizontal overflow remains (${snapshot.document.scrollWidth}px > ${snapshot.viewport.width}px)`);
    }

    const statusBeforeTokens = await captureSnapshot(surfaces.statusPage, 'status-before-token-reflow');
    const statusSpacingTokenBefore = await surfaces.statusPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bf-space-6').trim());
    const statusTokenPayload = {
      theme: 'forest',
      font_scale: 1.1,
      ui_scale: 1.2,
      card_radius_px: 28,
      shadow_intensity: 1.4,
      status_page_scale: 0.78,
      layout_mode: 'portrait',
    };
    await surfaces.settingsPage.evaluate((payload) => {
      if (typeof applyDesignControls !== 'function') {
        throw new Error('applyDesignControls is not available on settings page');
      }
      applyDesignControls(payload);
    }, statusTokenPayload);
    await surfaces.statusPage.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bf-space-6').trim() !== '56px');
    await surfaces.previewFrame.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bf-space-6').trim() !== '56px');
    await waitForLayoutReady(surfaces.statusPage);
    await waitForLayoutReady(surfaces.previewFrame);

    const statusAfterTokens = await captureSnapshot(surfaces.statusPage, 'status-after-token-reflow');
    const previewAfterTokens = await captureSnapshot(surfaces.previewFrame, 'preview-after-token-reflow');
    recordSnapshotArtifact('status-after-token-reflow', statusAfterTokens, surfaces.statusConsole, {
      previewSnapshot: previewAfterTokens,
    });

    const metricsBefore = collectSpacingMetrics(statusBeforeTokens);
    const metricsAfter = collectSpacingMetrics(statusAfterTokens);
    const statusSpacingTokenAfter = await surfaces.statusPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bf-space-6').trim());
    assert.notEqual(statusSpacingTokenAfter, statusSpacingTokenBefore, 'Status spacing tokens did not update on the real status page');
    assert.notDeepEqual(
      statusAfterTokens.cards.map((card) => ({ key: card.key, height: card.rect.height, width: card.rect.width })),
      statusBeforeTokens.cards.map((card) => ({ key: card.key, height: card.rect.height, width: card.rect.width })),
      'Status token changes did not alter card geometry'
    );
    assertNoOverlap(statusAfterTokens);
    assertNoOverlap(previewAfterTokens);
    assertFibonacciRatios(statusAfterTokens);

    const settingsBeforeTokens = await captureSnapshot(surfaces.settingsPage, 'settings-before-token-reflow');
    const settingsSpacingTokenBefore = await surfaces.settingsPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dcs-space-6').trim());
    await surfaces.settingsPage.evaluate(() => {
      if (typeof applyDesignControls !== 'function') {
        throw new Error('applyDesignControls is not available on settings page');
      }
      applyDesignControls({
        theme: 'ocean',
        font_scale: 0.9,
        ui_scale: 0.8,
        card_radius_px: 8,
        shadow_intensity: 0.2,
        status_page_scale: 0.92,
      });
    });
    await waitForLayoutReady(surfaces.settingsPage);

    const settingsAfterTokens = await captureSnapshot(surfaces.settingsPage, 'settings-after-token-reflow');
    recordSnapshotArtifact('settings-after-token-reflow', settingsAfterTokens, surfaces.settingsConsole);
  const settingsSpacingTokenAfter = await surfaces.settingsPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dcs-space-6').trim());
  assert.notEqual(settingsSpacingTokenAfter, settingsSpacingTokenBefore, 'Settings spacing tokens did not update on the real settings page');
    assertNoOverlap(settingsAfterTokens);
    assertFibonacciRatios(settingsAfterTokens);
    assertSpacingBounds(settingsAfterTokens, {
      maxHorizontalGap: Math.max(settingsAfterTokens.container.gap + 24, 32),
      minHorizontalGap: 0,
      maxUnusedAreaRatio: 0.82,
    });
  } finally {
    await surfaces.context.close();
  }
});

test('preview and settings do not leave screenshot-scale empty regions after default load or auto arrange', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'screenshot-regressions');

  try {
    const previewDefault = await captureSnapshot(surfaces.previewFrame, 'preview-screenshot-default');
    const settingsDefault = await captureSnapshot(surfaces.settingsPage, 'settings-screenshot-default');
    recordSnapshotArtifact('screenshot-regressions-default', previewDefault, surfaces.previewConsole, {
      settingsSnapshot: settingsDefault,
    });

    assert.ok(previewDefault.cards.some((card) => card.key === 'setup-hero'), 'Preview is missing the Setup Hero card');
    assert.ok(previewDefault.cards.some((card) => card.key === 'quick-facts'), 'Preview is missing the Quick Facts card');
    assert.ok(previewDefault.cards.some((card) => card.key === 'browser-links'), 'Preview is missing the Browser Links card');
    assert.ok(previewDefault.document.scrollWidth <= previewDefault.viewport.width + 32, 'Preview still requires horizontal scrolling at default load');
    assert.ok(collectSpacingMetrics(previewDefault).unusedAreaRatio <= 0.45, `Preview default layout leaves excessive empty area (${collectSpacingMetrics(previewDefault).unusedAreaRatio})`);
    assert.ok(collectSpacingMetrics(settingsDefault).unusedAreaRatio <= 0.45, `Settings default layout leaves excessive empty area (${collectSpacingMetrics(settingsDefault).unusedAreaRatio})`);

    await surfaces.settingsPage.evaluate(() => {
      window.__bellforgeStatusPreview?.autoArrange?.();
      window.__bellforgeSettingsLayout?.autoArrange?.();
    });
    await waitForLayoutReady(surfaces.previewFrame);
    await waitForLayoutReady(surfaces.settingsPage);

    const previewAuto = await captureSnapshot(surfaces.previewFrame, 'preview-screenshot-auto');
    const settingsAuto = await captureSnapshot(surfaces.settingsPage, 'settings-screenshot-auto');
    recordSnapshotArtifact('screenshot-regressions-auto', previewAuto, surfaces.previewConsole, {
      settingsSnapshot: settingsAuto,
    });

    assert.ok(collectSpacingMetrics(previewAuto).unusedAreaRatio <= 0.4, `Preview auto-arrange still leaves excessive empty area (${collectSpacingMetrics(previewAuto).unusedAreaRatio})`);
    assert.ok(collectSpacingMetrics(settingsAuto).unusedAreaRatio <= 0.4, `Settings auto-arrange still leaves excessive empty area (${collectSpacingMetrics(settingsAuto).unusedAreaRatio})`);
    assert.ok(previewAuto.document.scrollWidth <= previewAuto.viewport.width + 32, 'Preview still requires horizontal scrolling after auto-arrange');
  } finally {
    await surfaces.context.close();
  }
});