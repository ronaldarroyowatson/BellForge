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
  readOrderedState,
  waitForOrderedState,
  assertConsoleContains,
  simplifyLayout,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

async function getCurrentPreviewFrame(settingsPage) {
  const handle = await settingsPage.$('#designStatusMirror');
  const frame = await handle?.contentFrame();
  if (!frame) {
    throw new Error('Preview iframe did not expose a content frame');
  }
  return frame;
}

test('preview modal stays identical to the status display page and pushes real updates back on sync actions', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'preview-sync');

  try {
    const previewInitial = await captureSnapshot(surfaces.previewFrame, 'preview-initial-sync');
    const displayInitial = await captureSnapshot(surfaces.displayPage, 'display-initial-sync');
    recordSnapshotArtifact('preview-initial-sync', previewInitial, surfaces.previewConsole, {
      displaySnapshot: displayInitial,
    });
    assert.deepEqual(simplifyLayout(previewInitial), simplifyLayout(displayInitial), 'Preview modal does not initially match the real status display page');

    await setCardCollapsed(surfaces.previewFrame, 'advanced', true);
    await waitForOrderedState(surfaces.displayPage, await readOrderedState(surfaces.previewFrame));
    await waitForLayoutReady(surfaces.displayPage);
    const previewCollapsed = await captureSnapshot(surfaces.previewFrame, 'preview-collapsed-sync');
    const displayCollapsed = await captureSnapshot(surfaces.displayPage, 'display-collapsed-sync');
    recordSnapshotArtifact('preview-collapsed-sync', previewCollapsed, surfaces.previewConsole, {
      displaySnapshot: displayCollapsed,
    });
    assert.deepEqual(simplifyLayout(previewCollapsed), simplifyLayout(displayCollapsed), 'Preview collapse did not update the real status display page');

    await dragCard(surfaces.previewFrame, 'advanced', 'browser-links');
  await waitForOrderedState(surfaces.displayPage, await readOrderedState(surfaces.previewFrame));
    await waitForLayoutReady(surfaces.displayPage);
    const previewDragged = await captureSnapshot(surfaces.previewFrame, 'preview-dragged-sync');
    const displayDragged = await captureSnapshot(surfaces.displayPage, 'display-dragged-sync');
    recordSnapshotArtifact('preview-dragged-sync', previewDragged, surfaces.previewConsole, {
      displaySnapshot: displayDragged,
    });
    assert.deepEqual(simplifyLayout(previewDragged), simplifyLayout(displayDragged), 'Preview drag-and-drop did not update the real status display page');

    await clickElement(surfaces.settingsPage, '#designStatusModalArrange');
    await waitForLayoutReady(surfaces.previewFrame);
    await waitForOrderedState(surfaces.displayPage, await readOrderedState(surfaces.previewFrame));
    await waitForLayoutReady(surfaces.displayPage);
    const previewAutoArranged = await captureSnapshot(surfaces.previewFrame, 'preview-auto-arranged-sync');
    const displayAutoArranged = await captureSnapshot(surfaces.displayPage, 'display-auto-arranged-sync');
    recordSnapshotArtifact('preview-auto-arranged-sync', previewAutoArranged, surfaces.previewConsole, {
      displaySnapshot: displayAutoArranged,
    });
    assert.deepEqual(simplifyLayout(previewAutoArranged), simplifyLayout(displayAutoArranged), 'Preview auto-arrange did not update the real status display page');

    await dragCard(surfaces.displayPage, 'stats', 'advanced');
    await clickElement(surfaces.settingsPage, '#designStatusModalReload');
    const previewFrame = await getCurrentPreviewFrame(surfaces.settingsPage);
    await waitForOrderedState(previewFrame, await readOrderedState(surfaces.displayPage));
    await waitForLayoutReady(previewFrame);
    const previewAfterReload = await captureSnapshot(previewFrame, 'preview-after-reload-sync');
    const displayAfterReload = await captureSnapshot(surfaces.displayPage, 'display-after-reload-sync');
    recordSnapshotArtifact('preview-after-reload-sync', previewAfterReload, surfaces.previewConsole, {
      displaySnapshot: displayAfterReload,
    });
    assert.deepEqual(simplifyLayout(previewAfterReload), simplifyLayout(displayAfterReload), 'Reload Mirror did not refresh the preview to the current real status page layout');

    assertConsoleContains(surfaces.settingsConsole, 'preview-to-status sync events', 'preview sync console');
    assertConsoleContains(surfaces.settingsConsole, 'preview modal size calculations', 'preview sizing console');
  } finally {
    await surfaces.context.close();
  }
});