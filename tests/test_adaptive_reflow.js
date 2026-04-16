const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openRealSurfaces,
  captureSnapshot,
  recordSnapshotArtifact,
  setCardCollapsed,
  assertNoOverlap,
  assertSpacing,
  assertSpacingBounds,
  assertWhitespaceImproves,
  assertMovement,
  collectSpacingMetrics,
  countVisibleCards,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

function pickDeterministicCard(snapshot, options = {}) {
  const excluded = new Set(options.exclude || []);
  const candidates = snapshot.cards.filter((card) => !excluded.has(card.key));
  assert.ok(candidates.length > 0, `${snapshot.kind}: no candidate cards available`);
  const seed = options.seed ?? 7;
  return candidates[seed % candidates.length];
}

function assertExpandedCardFullyOpen(snapshot, key) {
  const card = snapshot.cards.find((entry) => entry.key === key);
  assert.ok(card, `${snapshot.kind}: missing card ${key}`);
  assert.equal(card.collapsed, false, `${snapshot.kind}: ${key} is still collapsed`);
  assert.ok(card.contentHeight + 2 >= card.contentScrollHeight, `${snapshot.kind}: ${key} content is clipped (${card.contentHeight}px visible vs ${card.contentScrollHeight}px scroll)`);
}

function assertCardShrank(beforeSnapshot, afterSnapshot, key) {
  const before = beforeSnapshot.cards.find((entry) => entry.key === key);
  const after = afterSnapshot.cards.find((entry) => entry.key === key);
  assert.ok(before && after, `${afterSnapshot.kind}: missing ${key} before/after collapse`);
  assert.ok(after.rect.height + 4 < before.rect.height, `${afterSnapshot.kind}: ${key} did not shrink after collapse`);
}

test('adaptive layout reflows around expand and collapse events without leaving large empty gaps', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'adaptive-reflow');

  try {
    const statusExpanded = await captureSnapshot(surfaces.statusPage, 'status-expanded');
    recordSnapshotArtifact('status-expanded', statusExpanded, surfaces.statusConsole);

    await setCardCollapsed(surfaces.statusPage, 'browser-links', true);
    const statusCollapsed = await captureSnapshot(surfaces.statusPage, 'status-collapsed');
    recordSnapshotArtifact('status-collapsed', statusCollapsed, surfaces.statusConsole);

    const cardsPulledUp = statusCollapsed.cards.some((card) => {
      const beforeCard = statusExpanded.cards.find((entry) => entry.key === card.key);
      return beforeCard && card.key !== 'browser-links' && card.rect.y + 4 < beforeCard.rect.y;
    });
    assert.ok(cardsPulledUp, 'Cards did not pull upward when a large card collapsed');
    assert.ok(countVisibleCards(statusCollapsed) >= countVisibleCards(statusExpanded), 'Collapsing a card did not maximize visible space');
    assertNoOverlap(statusCollapsed);
    assertSpacing(statusCollapsed, { minVisibleCards: countVisibleCards(statusExpanded) });

    await setCardCollapsed(surfaces.statusPage, 'browser-links', false);
    const statusReexpanded = await captureSnapshot(surfaces.statusPage, 'status-reexpanded');
    recordSnapshotArtifact('status-reexpanded', statusReexpanded, surfaces.statusConsole);

    const cardsPushedDown = statusReexpanded.cards.some((card) => {
      const beforeCard = statusCollapsed.cards.find((entry) => entry.key === card.key);
      return beforeCard && card.key !== 'browser-links' && card.rect.y - 4 > beforeCard.rect.y;
    });
    assert.ok(cardsPushedDown, 'Cards did not move out of the way when a large card expanded');
    assertNoOverlap(statusReexpanded);
    assertMovement(statusCollapsed, statusReexpanded, { requireHorizontal: false, requireVertical: true });

    const settingsBefore = await captureSnapshot(surfaces.settingsPage, 'settings-before-collapse');
    recordSnapshotArtifact('settings-before-collapse', settingsBefore, surfaces.settingsConsole);

    for (const key of ['display-pipeline', 'network', 'autoupdater', 'design-controls', 'authentication', 'logs']) {
      await setCardCollapsed(surfaces.settingsPage, key, true);
    }
    const settingsCollapsed = await captureSnapshot(surfaces.settingsPage, 'settings-collapsed');
    recordSnapshotArtifact('settings-collapsed', settingsCollapsed, surfaces.settingsConsole);

    await setCardCollapsed(surfaces.settingsPage, 'network', false);
    await setCardCollapsed(surfaces.settingsPage, 'design-controls', false);
    const settingsExpanded = await captureSnapshot(surfaces.settingsPage, 'settings-reexpanded');
    recordSnapshotArtifact('settings-reexpanded', settingsExpanded, surfaces.settingsConsole);

    const settingsCollapsedSpacing = collectSpacingMetrics(settingsCollapsed);
    const settingsExpandedSpacing = collectSpacingMetrics(settingsExpanded);

    assertNoOverlap(settingsCollapsed);
    assertNoOverlap(settingsExpanded);
    assertSpacingBounds(settingsExpanded, {
      maxVerticalGap: Math.max(settingsExpanded.container.gap + 96, 112),
      maxHorizontalGap: Math.max(settingsExpanded.container.gap + 24, 32),
    });
    assert.ok(
      settingsExpandedSpacing.maxVerticalGap <= settingsCollapsedSpacing.maxVerticalGap + settingsExpanded.container.gap + 8,
      `Settings re-expansion created oversized vertical gaps (${settingsExpandedSpacing.maxVerticalGap}px after ${settingsCollapsedSpacing.maxVerticalGap}px)`
    );
    assertMovement(settingsCollapsed, settingsExpanded, { requireHorizontal: false, requireVertical: true });
    assertWhitespaceImproves(settingsBefore, settingsCollapsed, 'settings collapse density', 0.08);

    await setCardCollapsed(surfaces.previewFrame, 'advanced', true);
    const previewCollapsed = await captureSnapshot(surfaces.previewFrame, 'preview-collapsed');
    recordSnapshotArtifact('preview-collapsed', previewCollapsed, surfaces.previewConsole);
    assertNoOverlap(previewCollapsed);
    assertSpacing(previewCollapsed, { minVisibleCards: 2 });
  } finally {
    await surfaces.context.close();
  }
});

test('deterministic random expand and collapse fully open cards, avoid clipping, and force full Fibonacci reflow on status settings and preview', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'adaptive-random-card');

  try {
    const statusBaseline = await captureSnapshot(surfaces.statusPage, 'status-random-baseline');
    const statusExpandTarget = statusBaseline.cards.find((card) => card.key === 'setup-hero') || pickDeterministicCard(statusBaseline, { seed: 5 });
    await setCardCollapsed(surfaces.statusPage, statusExpandTarget.key, true);
    const statusCollapsed = await captureSnapshot(surfaces.statusPage, 'status-random-collapsed');
    await setCardCollapsed(surfaces.statusPage, statusExpandTarget.key, false);
    const statusExpanded = await captureSnapshot(surfaces.statusPage, 'status-random-expanded');
    recordSnapshotArtifact('status-random-expand-collapse', statusExpanded, surfaces.statusConsole, {
      baseline: statusBaseline,
      collapsed: statusCollapsed,
      target: statusExpandTarget.key,
    });
    assertExpandedCardFullyOpen(statusExpanded, statusExpandTarget.key);
    assertCardShrank(statusBaseline, statusCollapsed, statusExpandTarget.key);
    assertNoOverlap(statusCollapsed);
    assertNoOverlap(statusExpanded);
    assertMovement(statusCollapsed, statusExpanded, { requireHorizontal: false, requireVertical: true });
    assertSpacing(statusCollapsed, { minVisibleCards: 3 });
    assertSpacingBounds(statusExpanded, {
      maxVerticalGap: Math.max(statusExpanded.container.gap + 72, 96),
      maxHorizontalGap: Math.max(statusExpanded.container.gap + 24, 32),
    });

    const settingsBaseline = await captureSnapshot(surfaces.settingsPage, 'settings-random-baseline');
    const settingsExpandTarget = pickDeterministicCard(settingsBaseline, { seed: 9 });
    await setCardCollapsed(surfaces.settingsPage, settingsExpandTarget.key, false);
    const settingsExpanded = await captureSnapshot(surfaces.settingsPage, 'settings-random-expanded');
    await setCardCollapsed(surfaces.settingsPage, settingsExpandTarget.key, true);
    const settingsCollapsed = await captureSnapshot(surfaces.settingsPage, 'settings-random-collapsed');
    recordSnapshotArtifact('settings-random-expand-collapse', settingsExpanded, surfaces.settingsConsole, {
      baseline: settingsBaseline,
      collapsed: settingsCollapsed,
      target: settingsExpandTarget.key,
    });
    assertExpandedCardFullyOpen(settingsExpanded, settingsExpandTarget.key);
    assertCardShrank(settingsExpanded, settingsCollapsed, settingsExpandTarget.key);
    assertNoOverlap(settingsExpanded);
    assertNoOverlap(settingsCollapsed);
    assertMovement(settingsExpanded, settingsCollapsed, { requireHorizontal: false, requireVertical: true });
    assertSpacingBounds(settingsCollapsed, {
      maxVerticalGap: Math.max(settingsCollapsed.container.gap + 48, 64),
      maxHorizontalGap: Math.max(settingsCollapsed.container.gap + 24, 32),
    });

    const previewBaseline = await captureSnapshot(surfaces.previewFrame, 'preview-random-baseline');
    const previewExpandTarget = previewBaseline.cards.find((card) => card.key === 'setup-hero') || pickDeterministicCard(previewBaseline, { seed: 11 });
    await setCardCollapsed(surfaces.previewFrame, previewExpandTarget.key, true);
    const previewCollapsed = await captureSnapshot(surfaces.previewFrame, 'preview-random-collapsed');
    await setCardCollapsed(surfaces.previewFrame, previewExpandTarget.key, false);
    const previewExpanded = await captureSnapshot(surfaces.previewFrame, 'preview-random-expanded');
    recordSnapshotArtifact('preview-random-expand-collapse', previewExpanded, surfaces.previewConsole, {
      baseline: previewBaseline,
      collapsed: previewCollapsed,
      target: previewExpandTarget.key,
    });
    assertExpandedCardFullyOpen(previewExpanded, previewExpandTarget.key);
    assertCardShrank(previewBaseline, previewCollapsed, previewExpandTarget.key);
    assertNoOverlap(previewCollapsed);
    assertNoOverlap(previewExpanded);
    assertMovement(previewCollapsed, previewExpanded, { requireHorizontal: false, requireVertical: true });
    assertSpacing(previewExpanded, { minVisibleCards: 2 });
  } finally {
    await surfaces.context.close();
  }
});