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
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('manual drag attempts on the unauthenticated real status page do not corrupt layout state', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'manual-drag');

  try {
    await setCardCollapsed(surfaces.statusPage, 'advanced', true);
    const statusBeforeDrag = await captureSnapshot(surfaces.statusPage, 'status-before-live-drag');
    await dragCard(surfaces.statusPage, 'advanced', 'browser-links');
    const statusAfterDrag = await captureSnapshot(surfaces.statusPage, 'status-after-live-drag');
    recordSnapshotArtifact('status-after-live-drag', statusAfterDrag, surfaces.statusConsole, {
      beforeSnapshot: statusBeforeDrag,
    });

    const draggedAdvanced = statusAfterDrag.cards.find((card) => card.key === 'advanced');
    assert.deepEqual(
      statusAfterDrag.cards.map((card) => card.key),
      statusBeforeDrag.cards.map((card) => card.key),
      'Unauthenticated drag attempt unexpectedly changed the real status layout order',
    );
    assert.equal(draggedAdvanced.collapsed, true, 'Dragged card lost its collapsed state');
    assertNoOverlap(statusAfterDrag);
    assertFibonacciRatios(statusAfterDrag);
  } finally {
    await surfaces.context.close();
  }
});