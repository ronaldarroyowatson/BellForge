function round(value) {
  return Math.round(value * 100) / 100;
}

function rowGroups(snapshot) {
  const groups = new Map();
  for (const card of snapshot.cards || []) {
    const rowIndex = Number(card.rowIndex || 0);
    if (!groups.has(rowIndex)) {
      groups.set(rowIndex, []);
    }
    groups.get(rowIndex).push(card);
  }
  return Array.from(groups.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, items]) => items.sort((left, right) => left.colStart - right.colStart));
}

function collectOverlaps(snapshot) {
  const overlaps = [];
  const cards = snapshot.cards || [];
  for (let index = 0; index < cards.length; index += 1) {
    for (let compare = index + 1; compare < cards.length; compare += 1) {
      const left = cards[index].rect;
      const right = cards[compare].rect;
      const isOverlapping = !(left.bottom <= right.y + 1 || right.bottom <= left.y + 1 || left.right <= right.x + 1 || right.right <= left.x + 1);
      if (isOverlapping) {
        overlaps.push({ left: cards[index].key, right: cards[compare].key });
      }
    }
  }
  return overlaps;
}

function findFibonacciRatioIssues(snapshot, tolerance = 0.03) {
  void tolerance;
  const issues = [];
  for (const card of snapshot.cards || []) {
    if (Number(card.colSpan || 1) !== 1) {
      issues.push({
        left: card.key,
        right: card.key,
        actualRatio: round(Number(card.colSpan || 1)),
        expectedRatio: 1,
        delta: round(Math.abs(Number(card.colSpan || 1) - 1)),
      });
    }
  }
  return issues;
}

function findWeightOrderingIssues(snapshot) {
  const issues = [];
  const cards = snapshot.cards || [];
  for (let index = 0; index < cards.length; index += 1) {
    for (let compare = index + 1; compare < cards.length; compare += 1) {
      if (cards[index].weight > cards[compare].weight && cards[index].colSpan < cards[compare].colSpan) {
        issues.push({ heavier: cards[index].key, lighter: cards[compare].key });
      }
    }
  }
  return issues;
}

function countVisibleCards(snapshot, viewportHeight = snapshot.viewport?.height || Number.MAX_SAFE_INTEGER) {
  return (snapshot.cards || []).filter((card) => card.rect.y < viewportHeight && card.rect.bottom > 0 && card.rect.width > 0 && card.rect.height > 0).length;
}

function collectSpacingMetrics(snapshot) {
  const groups = rowGroups(snapshot);
  const verticalGaps = [];
  const horizontalGaps = [];

  for (let index = 1; index < groups.length; index += 1) {
    const previousBottom = Math.max(...groups[index - 1].map((item) => item.rect.bottom));
    const nextTop = Math.min(...groups[index].map((item) => item.rect.y));
    verticalGaps.push(round(nextTop - previousBottom));
  }

  for (const items of groups) {
    for (let index = 1; index < items.length; index += 1) {
      horizontalGaps.push(round(items[index].rect.x - items[index - 1].rect.right));
    }
  }

  const top = groups.length ? Math.min(...groups.flat().map((item) => item.rect.y)) : 0;
  const bottom = groups.length ? Math.max(...groups.flat().map((item) => item.rect.bottom)) : 0;
  const occupiedArea = (snapshot.cards || []).reduce((sum, card) => sum + (card.rect.width * card.rect.height), 0);
  const boundingArea = Math.max(0, (snapshot.container?.width || 0) * Math.max(0, bottom - top));
  const unusedAreaRatio = boundingArea > 0 ? Math.max(0, Math.min(1, 1 - (occupiedArea / boundingArea))) : 0;

  return {
    verticalGaps,
    horizontalGaps,
    maxVerticalGap: verticalGaps.length ? Math.max(...verticalGaps) : 0,
    maxHorizontalGap: horizontalGaps.length ? Math.max(...horizontalGaps) : 0,
    minHorizontalGap: horizontalGaps.length ? Math.min(...horizontalGaps) : 0,
    visibleCards: countVisibleCards(snapshot),
    collapsedVisibleCards: (snapshot.cards || []).filter((card) => card.collapsed && card.rect.y < (snapshot.viewport?.height || Number.MAX_SAFE_INTEGER) && card.rect.bottom > 0).length,
    unusedAreaRatio: round(unusedAreaRatio),
    top: round(top),
    bottom: round(bottom),
  };
}

function simplifyLayout(snapshot) {
  return {
    layoutMode: snapshot.layoutMode || null,
    columns: snapshot.container?.columns || 0,
    gap: snapshot.container?.gap || 0,
    cards: (snapshot.cards || []).map((card) => ({
      key: card.key,
      collapsed: card.collapsed,
      rowIndex: card.rowIndex,
      colStart: card.colStart,
      colSpan: card.colSpan,
      order: card.order,
    })),
  };
}

module.exports = {
  collectOverlaps,
  collectSpacingMetrics,
  countVisibleCards,
  findFibonacciRatioIssues,
  findWeightOrderingIssues,
  rowGroups,
  simplifyLayout,
};