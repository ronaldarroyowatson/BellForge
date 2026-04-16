const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  dragCard,
  setCardCollapsed,
  assertNoOverlap,
  assertFibonacciRatios,
  assertConsoleContains,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('manual drag-and-drop reorders cards, preserves collapse state, and syncs preview with the real status page', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'manual-drag');

  try {
    await setCardCollapsed(surfaces.statusPage, 'advanced', true);
    await dragCard(surfaces.statusPage, 'advanced', 'browser-links');
    const statusAfterDrag = await captureSnapshot(surfaces.statusPage, 'status-after-live-drag');
    recordSnapshotArtifact('status-after-live-drag', statusAfterDrag, surfaces.statusConsole);

    const draggedAdvanced = statusAfterDrag.cards.find((card) => card.key === 'advanced');
    assert.equal(statusAfterDrag.cards[1].key, 'advanced', 'Status drag-and-drop did not move the card to the requested position');
    assert.equal(draggedAdvanced.collapsed, true, 'Dragged card lost its collapsed state');
    assertNoOverlap(statusAfterDrag);
    assertFibonacciRatios(statusAfterDrag);

    assertConsoleContains(surfaces.statusConsole, 'drag-and-drop events', 'status drag console');
  } finally {
    await surfaces.context.close();
  }
});