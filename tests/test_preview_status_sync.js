const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  waitForLayoutReady,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('settings exposes direct access to real status surfaces and shared commands keep real display pages healthy', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'real-status-access');

  try {
    const settingsState = await surfaces.settingsPage.evaluate(() => ({
      hasOpenStatusButton: Boolean(document.getElementById('openStatusPage')),
      hasOpenDisplayButton: Boolean(document.getElementById('openDisplayStatusPage')),
      previewModalPresent: Boolean(document.getElementById('designStatusPreviewModal')),
      previewIframePresent: Boolean(document.getElementById('designStatusMirror')),
      accessNote: document.getElementById('designStatusAccessNote')?.textContent?.trim() || '',
    }));

    assert.equal(settingsState.hasOpenStatusButton, true, 'Settings page is missing the real status page button');
    assert.equal(settingsState.hasOpenDisplayButton, true, 'Settings page is missing the real display output button');
    assert.equal(settingsState.previewModalPresent, false, 'Settings page still exposes the removed preview modal');
    assert.equal(settingsState.previewIframePresent, false, 'Settings page still exposes the removed preview iframe');
    assert.ok(settingsState.accessNote.length > 0, 'Settings page did not explain the real-status workflow');

    const directDisplaySnapshot = await captureSnapshot(surfaces.settingsDisplayPage, 'real-status-access-settings-display');
    const displaySnapshot = await captureSnapshot(surfaces.displayPage, 'real-status-access-display');
    recordSnapshotArtifact('real-status-access-display', directDisplaySnapshot, surfaces.settingsDisplayConsole, {
      referenceSnapshot: displaySnapshot,
    });

    assert.deepEqual(
      directDisplaySnapshot.cards.map((card) => card.key),
      displaySnapshot.cards.map((card) => card.key),
      'Direct real display access does not expose the same card registry as the display page',
    );
    assert.ok(directDisplaySnapshot.cards.length >= 6, 'Direct display surface exposed too few cards');
    assert.ok(displaySnapshot.cards.length >= 6, 'Display surface exposed too few cards');

    await surfaces.settingsPage.evaluate(() => {
      localStorage.setItem('bellforge.status.layout-command.v1', JSON.stringify({
        source: 'browser-dom-verification',
        timestamp: Date.now(),
        type: 'auto-arrange',
        payload: {},
      }));
    });
    await waitForLayoutReady(surfaces.settingsDisplayPage);
    await waitForLayoutReady(surfaces.displayPage);

    const afterAutoDirect = await captureSnapshot(surfaces.settingsDisplayPage, 'real-status-access-settings-display-auto');
    const afterAutoDisplay = await captureSnapshot(surfaces.displayPage, 'real-status-access-display-auto');
    recordSnapshotArtifact('real-status-access-display-auto', afterAutoDirect, surfaces.settingsDisplayConsole, {
      referenceSnapshot: afterAutoDisplay,
    });

    assert.equal(afterAutoDirect.container.columns, afterAutoDisplay.container.columns, 'Shared command changed column counts inconsistently across real display surfaces');
    assert.deepEqual(
      afterAutoDirect.cards.map((card) => card.key),
      afterAutoDisplay.cards.map((card) => card.key),
      'Shared command left the two real display surfaces with different card registries',
    );
  } finally {
    await surfaces.context.close();
  }
});