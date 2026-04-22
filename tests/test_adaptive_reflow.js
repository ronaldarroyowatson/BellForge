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
  const computedHeight = Number.parseFloat(card.computed?.height || '0');
  const scale = computedHeight > 0 ? Math.max(0.5, Math.min(1, card.rect.height / computedHeight)) : 1;
  const expectedVisibleHeight = card.contentScrollHeight * scale;
  assert.ok(
    card.contentHeight + 2 >= expectedVisibleHeight,
    `${snapshot.kind}: ${key} content is clipped (${card.contentHeight}px visible vs ${card.contentScrollHeight}px scroll at scale ${scale.toFixed(2)})`
  );
}

function assertCardShrank(beforeSnapshot, afterSnapshot, key) {
  const before = beforeSnapshot.cards.find((entry) => entry.key === key);
  const after = afterSnapshot.cards.find((entry) => entry.key === key);
  assert.ok(before && after, `${afterSnapshot.kind}: missing ${key} before/after collapse`);
  assert.ok(after.rect.height + 4 < before.rect.height, `${afterSnapshot.kind}: ${key} did not shrink after collapse`);
}

function cardsBelowInSameColumn(snapshot, key) {
  const target = snapshot.cards.find((entry) => entry.key === key);
  if (!target) {
    return [];
  }
  return snapshot.cards
    .filter((entry) => entry.key !== key && entry.colStart === target.colStart && entry.rowStart > target.rowStart)
    .map((entry) => entry.key);
}

function pickReflowTarget(snapshot, preferredKeys = []) {
  for (const key of preferredKeys) {
    const card = snapshot.cards.find((entry) => entry.key === key);
    if (card && cardsBelowInSameColumn(snapshot, key).length > 0) {
      return key;
    }
  }
  const firstWithFollowers = snapshot.cards.find((card) => cardsBelowInSameColumn(snapshot, card.key).length > 0);
  return firstWithFollowers?.key || preferredKeys[0] || snapshot.cards[0]?.key;
}

test('adaptive layout reflows around expand and collapse events without leaving large empty gaps', async () => {
  const surfaces = await openRealSurfaces(suite, { width: 1280, height: 720 }, 'adaptive-reflow');

  try {
    const statusExpanded = await captureSnapshot(surfaces.statusPage, 'status-expanded');
    recordSnapshotArtifact('status-expanded', statusExpanded, surfaces.statusConsole);

    const statusReflowTarget = pickReflowTarget(statusExpanded, ['browser-links', 'setup-hero', 'onboarding-qr']);
    assert.ok(statusReflowTarget, 'Unable to select a status card for collapse/expand reflow validation');

    await setCardCollapsed(surfaces.statusPage, statusReflowTarget, true);
    const statusCollapsed = await captureSnapshot(surfaces.statusPage, 'status-collapsed');
    recordSnapshotArtifact('status-collapsed', statusCollapsed, surfaces.statusConsole);

    const affectedStatusKeys = cardsBelowInSameColumn(statusExpanded, statusReflowTarget);
    const cardsPulledUp = (affectedStatusKeys.length > 0 ? affectedStatusKeys : statusCollapsed.cards.map((card) => card.key)).some((key) => {
      if (key === statusReflowTarget) {
        return false;
      }
      const card = statusCollapsed.cards.find((entry) => entry.key === key);
      const beforeCard = statusExpanded.cards.find((entry) => entry.key === card.key);
      return beforeCard && card && card.rect.y + 4 < beforeCard.rect.y;
    });
    if (affectedStatusKeys.length > 0) {
      assert.ok(cardsPulledUp, 'Cards did not pull upward when a reflow target collapsed');
    }
    assertCardShrank(statusExpanded, statusCollapsed, statusReflowTarget);
    assert.ok(countVisibleCards(statusCollapsed) >= countVisibleCards(statusExpanded), 'Collapsing a card did not maximize visible space');
    assertNoOverlap(statusCollapsed);
    assertSpacing(statusCollapsed, { minVisibleCards: countVisibleCards(statusExpanded) });

    await setCardCollapsed(surfaces.statusPage, statusReflowTarget, false);
    const statusReexpanded = await captureSnapshot(surfaces.statusPage, 'status-reexpanded');
    recordSnapshotArtifact('status-reexpanded', statusReexpanded, surfaces.statusConsole);

    const cardsPushedDown = (affectedStatusKeys.length > 0 ? affectedStatusKeys : statusReexpanded.cards.map((card) => card.key)).some((key) => {
      if (key === statusReflowTarget) {
        return false;
      }
      const card = statusReexpanded.cards.find((entry) => entry.key === key);
      const beforeCard = statusCollapsed.cards.find((entry) => entry.key === card.key);
      return beforeCard && card && card.rect.y - 4 > beforeCard.rect.y;
    });
    if (affectedStatusKeys.length > 0) {
      assert.ok(cardsPushedDown, 'Cards did not move out of the way when a reflow target expanded');
      assertMovement(statusCollapsed, statusReexpanded, {
        keys: affectedStatusKeys,
        requireHorizontal: false,
        requireVertical: true,
      });
    }
    assertNoOverlap(statusReexpanded);

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

    await setCardCollapsed(surfaces.settingsDisplayPage, 'advanced', true);
    const settingsDisplayCollapsed = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-collapsed');
    recordSnapshotArtifact('settings-display-collapsed', settingsDisplayCollapsed, surfaces.settingsDisplayConsole);
    assertNoOverlap(settingsDisplayCollapsed);
    assertSpacing(settingsDisplayCollapsed, { minVisibleCards: 2 });
  } finally {
    await surfaces.context.close();
  }
});

test('deterministic random expand and collapse fully open cards, avoid clipping, and force full masonry reflow on status, settings, and linked display', async () => {
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
    const statusAffectedKeys = cardsBelowInSameColumn(statusExpanded, statusExpandTarget.key);
    if (statusAffectedKeys.length > 0) {
      assertMovement(statusCollapsed, statusExpanded, {
        keys: statusAffectedKeys,
        requireHorizontal: false,
        requireVertical: true,
      });
    }
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
    const settingsAffectedKeys = cardsBelowInSameColumn(settingsExpanded, settingsExpandTarget.key);
    if (settingsAffectedKeys.length > 0) {
      assertMovement(settingsExpanded, settingsCollapsed, {
        keys: settingsAffectedKeys,
        requireHorizontal: false,
        requireVertical: true,
      });
    }
    assertSpacingBounds(settingsCollapsed, {
      maxVerticalGap: Math.max(settingsCollapsed.container.gap + 48, 64),
      maxHorizontalGap: Math.max(settingsCollapsed.container.gap + 24, 32),
    });

    const settingsDisplayBaseline = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-random-baseline');
    const settingsDisplayExpandTarget = settingsDisplayBaseline.cards.find((card) => card.key === 'setup-hero') || pickDeterministicCard(settingsDisplayBaseline, { seed: 11 });
    await setCardCollapsed(surfaces.settingsDisplayPage, settingsDisplayExpandTarget.key, true);
    const settingsDisplayCollapsed = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-random-collapsed');
    await setCardCollapsed(surfaces.settingsDisplayPage, settingsDisplayExpandTarget.key, false);
    const settingsDisplayExpanded = await captureSnapshot(surfaces.settingsDisplayPage, 'settings-display-random-expanded');
    recordSnapshotArtifact('settings-display-random-expand-collapse', settingsDisplayExpanded, surfaces.settingsDisplayConsole, {
      baseline: settingsDisplayBaseline,
      collapsed: settingsDisplayCollapsed,
      target: settingsDisplayExpandTarget.key,
    });
    assertExpandedCardFullyOpen(settingsDisplayExpanded, settingsDisplayExpandTarget.key);
    assertCardShrank(settingsDisplayBaseline, settingsDisplayCollapsed, settingsDisplayExpandTarget.key);
    assertNoOverlap(settingsDisplayCollapsed);
    assertNoOverlap(settingsDisplayExpanded);
    const settingsDisplayAffectedKeys = cardsBelowInSameColumn(settingsDisplayExpanded, settingsDisplayExpandTarget.key);
    if (settingsDisplayAffectedKeys.length > 0) {
      assertMovement(settingsDisplayCollapsed, settingsDisplayExpanded, {
        keys: settingsDisplayAffectedKeys,
        requireHorizontal: false,
        requireVertical: true,
      });
    }
    assertSpacing(settingsDisplayExpanded, { minVisibleCards: 2 });
  } finally {
    await surfaces.context.close();
  }
});