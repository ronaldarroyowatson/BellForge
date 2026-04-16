const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  runScratchScenario,
  recordSnapshotArtifact,
  assertNoOverlap,
  countVisibleCards,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('null-set layout cases recover cleanly for empty, single-card, fully-collapsed, and fully-expanded registries', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'layout-null-sets');

  try {
    const emptySnapshot = await runScratchScenario(surfaces.statusPage, {
      kind: 'scratch-empty-layout',
      mode: 'status',
      cards: [],
      tracks: 5,
      maxPerRow: 2,
      storageKey: 'bellforge.test.scratch.empty',
    });
    recordSnapshotArtifact('scratch-empty-layout', emptySnapshot, surfaces.statusConsole);
    assert.equal(emptySnapshot.cards.length, 0, 'Empty layout should not render cards');

    const singleSnapshot = await runScratchScenario(surfaces.settingsPage, {
      kind: 'scratch-single-card-layout',
      mode: 'settings',
      cards: [{ key: 'single-card', title: 'Single Card', content: 'Only card present.' }],
      tracks: 5,
      maxPerRow: 2,
      storageKey: 'bellforge.test.scratch.single',
    });
    recordSnapshotArtifact('scratch-single-card-layout', singleSnapshot, surfaces.settingsConsole);
    assert.equal(singleSnapshot.cards.length, 1, 'Single-card layout should render exactly one card');
    assert.ok(singleSnapshot.cards[0].rect.width >= singleSnapshot.container.width * 0.55, 'Single-card layout did not maximize visible width');

    const allCollapsedSnapshot = await runScratchScenario(surfaces.previewFrame, {
      kind: 'scratch-all-collapsed-layout',
      mode: 'status-display',
      cards: [
        { key: 'alpha', title: 'Alpha', content: 'A' },
        { key: 'beta', title: 'Beta', content: 'B' },
        { key: 'gamma', title: 'Gamma', content: 'C' },
      ],
      collapsedKeys: ['alpha', 'beta', 'gamma'],
      tracks: 5,
      maxPerRow: 2,
      storageKey: 'bellforge.test.scratch.collapsed',
    });
    recordSnapshotArtifact('scratch-all-collapsed-layout', allCollapsedSnapshot, surfaces.previewConsole);
    assert.equal(allCollapsedSnapshot.cards.every((card) => card.collapsed), true, 'All-collapsed layout did not keep every card collapsed');
    assert.equal(countVisibleCards(allCollapsedSnapshot), allCollapsedSnapshot.cards.length, 'All-collapsed layout did not maximize visible cards');
    assert.equal(allCollapsedSnapshot.cards.some((card) => card.colSpan < allCollapsedSnapshot.container.columns), true, 'All-collapsed layout did not preserve packed multi-card rows');
    assertNoOverlap(allCollapsedSnapshot);

    const allExpandedSnapshot = await runScratchScenario(surfaces.displayPage, {
      kind: 'scratch-all-expanded-layout',
      mode: 'status-display',
      cards: [
        { key: 'alpha', title: 'Alpha', content: 'Expanded card content '.repeat(12) },
        { key: 'beta', title: 'Beta', content: 'Expanded card content '.repeat(8) },
        { key: 'gamma', title: 'Gamma', content: 'Expanded card content '.repeat(6) },
      ],
      tracks: 5,
      maxPerRow: 2,
      storageKey: 'bellforge.test.scratch.expanded',
    });
    recordSnapshotArtifact('scratch-all-expanded-layout', allExpandedSnapshot, surfaces.displayConsole);
    assert.equal(allExpandedSnapshot.cards.length, 3, 'All-expanded layout did not render all cards');
    assertNoOverlap(allExpandedSnapshot);
  } finally {
    await surfaces.context.close();
  }
});