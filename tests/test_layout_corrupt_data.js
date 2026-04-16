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
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('corrupt layout state, missing metadata, and invalid token values recover without breaking the real pages', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'layout-corrupt-data');

  try {
    await surfaces.statusPage.evaluate(() => {
      localStorage.setItem('bellforge.status.fibo-cards.v1', '{bad-json');
    });
    await surfaces.statusPage.reload({ waitUntil: 'domcontentloaded' });
    await waitForLayoutReady(surfaces.statusPage);
    const statusRecovered = await captureSnapshot(surfaces.statusPage, 'status-recovered-from-bad-json');
    recordSnapshotArtifact('status-recovered-from-bad-json', statusRecovered, surfaces.statusConsole);
    assertNoOverlap(statusRecovered);
    assertFibonacciRatios(statusRecovered);

    await surfaces.settingsPage.evaluate(() => {
      localStorage.setItem('bellforge.settings.fibo-cards.v1', '{bad-json');
    });
    await surfaces.settingsPage.reload({ waitUntil: 'domcontentloaded' });
    await waitForLayoutReady(surfaces.settingsPage);
    const settingsRecovered = await captureSnapshot(surfaces.settingsPage, 'settings-recovered-from-bad-json');
    recordSnapshotArtifact('settings-recovered-from-bad-json', settingsRecovered, surfaces.settingsConsole);
    assertNoOverlap(settingsRecovered);

    const scratchRecovered = await runScratchScenario(surfaces.statusPage, {
      kind: 'scratch-missing-metadata-layout',
      mode: 'status',
      cards: [
        { key: 'explicit', title: 'Explicit', content: 'Explicit metadata card', layoutPriority: 9 },
        { key: null, title: 'Generated Key', content: 'Missing key but valid title' },
        { key: 'missing-weight', title: 'Missing Weight', content: 'No layout weight provided', layoutPriority: 3 },
        { key: false, omitHeading: true, content: 'No key or heading metadata available' },
      ],
      stateRaw: '{bad-json',
      storageKey: 'bellforge.test.scratch.corrupt',
      tracks: 5,
      maxPerRow: 2,
    });
    recordSnapshotArtifact('scratch-missing-metadata-layout', scratchRecovered, surfaces.statusConsole);
    assert.equal(scratchRecovered.cards.length, 4, 'Scratch corrupt-data layout dropped cards');
    assert.equal(scratchRecovered.cards.every((card) => typeof card.key === 'string' && card.key.length > 0), true, 'Scratch corrupt-data layout failed to recover card keys');
    assertNoOverlap(scratchRecovered);

    const normalizedTokens = await surfaces.settingsPage.evaluate(() => {
      if (typeof normalizeDesignControls !== 'function' || typeof applyDesignControls !== 'function') {
        throw new Error('Settings design control helpers are not available');
      }
      const invalid = {
        theme: 'ocean',
        font_scale: Number.NaN,
        ui_scale: -999,
        card_radius_px: null,
        shadow_intensity: Number.NaN,
        status_page_scale: null,
      };
      const normalized = normalizeDesignControls(invalid);
      applyDesignControls(invalid);
      return normalized;
    });
    assert.equal(Number.isFinite(normalizedTokens.font_scale), true, 'Corrupt font scale was not normalized to a finite value');
    assert.equal(Number.isFinite(normalizedTokens.ui_scale), true, 'Corrupt UI scale was not normalized to a finite value');
    assert.equal(Number.isFinite(normalizedTokens.shadow_intensity), true, 'Corrupt shadow intensity was not normalized to a finite value');
    assert.equal(Number.isFinite(normalizedTokens.status_page_scale), true, 'Corrupt status page scale was not normalized to a finite value');

    await surfaces.statusPage.evaluate(() => {
      window.postMessage({
        type: 'bellforge-design-controls',
        payload: {
          theme: 'forest',
          font_scale: Number.NaN,
          ui_scale: -3,
          card_radius_px: null,
          shadow_intensity: Number.NaN,
          status_page_scale: null,
        },
      }, window.location.origin);
    });
    await waitForLayoutReady(surfaces.statusPage);
    const statusAfterInvalidTokens = await captureSnapshot(surfaces.statusPage, 'status-after-invalid-tokens');
    recordSnapshotArtifact('status-after-invalid-tokens', statusAfterInvalidTokens, surfaces.statusConsole);
    assertNoOverlap(statusAfterInvalidTokens);
  } finally {
    await surfaces.context.close();
  }
});