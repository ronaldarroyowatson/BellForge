const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layout = require('../client/js/fibonacci_layout.js');

const repoRoot = path.resolve(__dirname, '..');
const settingsHtml = fs.readFileSync(path.join(repoRoot, 'client', 'settings.html'), 'utf8');
const statusHtml = fs.readFileSync(path.join(repoRoot, 'client', 'status.html'), 'utf8');
const sharedLayoutSource = fs.readFileSync(path.join(repoRoot, 'client', 'js', 'fibonacci_layout.js'), 'utf8');
const snapshots = JSON.parse(fs.readFileSync(path.join(__dirname, 'layout_snapshots.json'), 'utf8'));

function extractCardKeys(html) {
  return Array.from(html.matchAll(/data-card-key="([^"]+)"/g), (match) => match[1]);
}

function descriptor(card, index, overrides = {}) {
  return {
    index,
    key: card.key,
    collapsed: false,
    explicitOrder: Number.MAX_SAFE_INTEGER,
    priority: 0,
    weight: 1,
    height: 120,
    ...card,
    ...overrides,
  };
}

function computeSnapshot(cards, options) {
  const plan = layout.computeLayoutPlan(cards.map((card, index) => descriptor(card, index)), options);
  return layout.snapshotFromPlan(plan);
}

function rectanglesOverlap(left, right) {
  const leftBottom = left.rowStart + left.rowSpan - 1;
  const rightBottom = right.rowStart + right.rowSpan - 1;
  const leftRight = left.colStart + left.colSpan - 1;
  const rightRight = right.colStart + right.colSpan - 1;
  return !(leftBottom < right.rowStart || rightBottom < left.rowStart || leftRight < right.colStart || rightRight < left.colStart);
}

const settingsCards = [
  { key: 'display-pipeline', priority: 9, weight: 9, height: 360 },
  { key: 'network', priority: 8, weight: 8, height: 320 },
  { key: 'autoupdater', priority: 8, weight: 8, height: 340 },
  { key: 'design-controls', priority: 7, weight: 7, height: 420 },
  { key: 'authentication', priority: 5, weight: 5, height: 200 },
  { key: 'logs', priority: 4, weight: 4, height: 280 },
];

const statusCards = [
  { key: 'hero', priority: 10, weight: 10, height: 520 },
  { key: 'browser-links', priority: 8, weight: 8, height: 320 },
  { key: 'onboarding-qr', priority: 7, weight: 7, height: 340 },
  { key: 'stats', priority: 6, weight: 6, height: 240 },
  { key: 'advanced', priority: 4, weight: 4, height: 300 },
];

test('collapse/expand shrinks to title-only height and stays in the same Fibonacci slot', () => {
  const expanded = computeSnapshot([
    { key: 'primary', priority: 9, weight: 9, height: 320 },
    { key: 'secondary', priority: 4, weight: 4, height: 200 },
  ], { tracks: 5, maxPerRow: 2, rowUnit: 8, preferImportance: true });
  const collapsed = computeSnapshot([
    { key: 'primary', priority: 9, weight: 9, height: 56, collapsed: true },
    { key: 'secondary', priority: 4, weight: 4, height: 200 },
  ], { tracks: 5, maxPerRow: 2, rowUnit: 8, preferImportance: true });

  assert.equal(collapsed[0].key, 'primary');
  assert.equal(collapsed[0].colSpan, expanded[0].colSpan);
  assert.ok(collapsed[0].rowSpan < expanded[0].rowSpan);
  assert.ok(collapsed.some((item) => item.key === 'primary'));
});

test('two-card and three-card rows use Fibonacci ratios', () => {
  assert.deepEqual(layout.buildRecursiveFibonacciRows(2, 3), [2]);
  assert.deepEqual(layout.ratiosForRowSize(2, 5), [3, 2]);
  assert.deepEqual(layout.ratiosForRowSize(3, 10), [5, 3, 2]);
});

test('four-plus cards use recursive Fibonacci row splits', () => {
  assert.deepEqual(layout.buildRecursiveFibonacciRows(4, 3), [2, 2]);
  assert.deepEqual(layout.buildRecursiveFibonacciRows(5, 3), [3, 2]);
  assert.deepEqual(layout.buildRecursiveFibonacciRows(7, 3), [2, 3, 2]);
});

test('cards reorder by content weight and priority on default layout generation', () => {
  const snapshot = computeSnapshot([
    { key: 'light', priority: 1, weight: 1, height: 140 },
    { key: 'heavy', priority: 8, weight: 8, height: 260 },
    { key: 'medium', priority: 4, weight: 4, height: 220 },
  ], { tracks: 10, maxPerRow: 3, rowUnit: 8, preferImportance: true });

  assert.deepEqual(snapshot.map((item) => item.key), ['heavy', 'medium', 'light']);
});

test('layout packs tightly with no unused track gaps inside a row', () => {
  const snapshot = computeSnapshot(settingsCards, { tracks: 10, maxPerRow: 3, rowUnit: 8, preferImportance: true });
  const rows = new Map();
  snapshot.forEach((item) => {
    if (!rows.has(item.rowIndex)) rows.set(item.rowIndex, []);
    rows.get(item.rowIndex).push(item);
  });
  for (const items of rows.values()) {
    items.sort((left, right) => left.colStart - right.colStart);
    let cursor = 1;
    let widthUsed = 0;
    for (const item of items) {
      assert.equal(item.colStart, cursor);
      cursor += item.colSpan;
      widthUsed += item.colSpan;
    }
    assert.equal(widthUsed, 10);
  }
});

test('expanding a card pushes cards below it out of the way and collapsing pulls them upward', () => {
  const collapsed = computeSnapshot([
    { key: 'hero', priority: 10, weight: 10, height: 56, collapsed: true },
    { key: 'browser-links', priority: 8, weight: 8, height: 320 },
    { key: 'onboarding-qr', priority: 7, weight: 7, height: 340 },
    { key: 'stats', priority: 6, weight: 6, height: 240 },
    { key: 'advanced', priority: 4, weight: 4, height: 300 },
  ], { tracks: 5, maxPerRow: 2, rowUnit: 8, preferImportance: true });

  const expanded = computeSnapshot(statusCards, { tracks: 5, maxPerRow: 2, rowUnit: 8, preferImportance: true });

  const collapsedAdvanced = collapsed.find((item) => item.key === 'advanced');
  const expandedAdvanced = expanded.find((item) => item.key === 'advanced');
  assert.ok(expandedAdvanced.rowStart > collapsedAdvanced.rowStart);
});

test('no card overlaps another after autolayout packing', () => {
  const snapshot = computeSnapshot(settingsCards, { tracks: 10, maxPerRow: 3, rowUnit: 8, preferImportance: true });
  for (let index = 0; index < snapshot.length; index += 1) {
    for (let compare = index + 1; compare < snapshot.length; compare += 1) {
      assert.equal(rectanglesOverlap(snapshot[index], snapshot[compare]), false, `${snapshot[index].key} overlaps ${snapshot[compare].key}`);
    }
  }
});

test('responsive track resolver reflows across breakpoints', () => {
  const resolver = layout.createDefaultTrackResolver('settings');
  assert.deepEqual(resolver(500), { tracks: 1, maxPerRow: 1 });
  assert.deepEqual(resolver(900), { tracks: 5, maxPerRow: 2 });
  assert.deepEqual(resolver(1300), { tracks: 10, maxPerRow: 3 });
});

test('settings and status pages use the shared engine instead of duplicated inline layout logic', () => {
  assert.match(settingsHtml, /<script src="\/client\/js\/fibonacci_layout\.js"><\/script>/);
  assert.match(statusHtml, /<script src="\/client\/js\/fibonacci_layout\.js"><\/script>/);
  assert.match(settingsHtml, /window\.BellForgeFibonacciLayout\.createAdaptiveLayout/);
  assert.match(statusHtml, /window\.BellForgeFibonacciLayout\.createAdaptiveLayout/);
});

test('settings page no longer relies on a static two-column top-level grid', () => {
  assert.doesNotMatch(settingsHtml, /grid-template-columns:\s*repeat\(2, minmax\(300px, 1fr\)\);/);
  assert.match(settingsHtml, /const SETTINGS_LAYOUT_STORAGE_KEY = "bellforge\.settings\.fibo-cards\.v1";/);
  assert.match(settingsHtml, /settingsAdaptiveLayout = createFibonacciAdaptiveLayout\(/);
});

test('settings card registry is complete and default priorities cover the most important cards', () => {
  const settingsKeys = extractCardKeys(settingsHtml);
  assert.deepEqual(settingsKeys, [
    'network',
    'authentication',
    'autoupdater',
    'display-pipeline',
    'design-controls',
    'logs',
  ]);
  assert.match(settingsHtml, /defaultPriorities:\s*\{[\s\S]*"display-pipeline": 9,[\s\S]*network: 8,[\s\S]*autoupdater: 8,[\s\S]*"design-controls": 7,/);
});

test('status display view no longer hardcodes top-level hero and panel slot positions', () => {
  assert.doesNotMatch(statusHtml, /body\.display-view \.hero \{[\s\S]*grid-column:\s*1 \/ 2;/);
  assert.doesNotMatch(statusHtml, /body\.display-view \.url-panel \{[\s\S]*grid-row:\s*2;/);
});

test('preview modal is full-screen, uses the real status page, and syncs through live commands', () => {
  assert.match(settingsHtml, /\.status-preview-modal \{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/);
  assert.match(settingsHtml, /mirrorUrl\.searchParams\.set\("view", "display"\);/);
  assert.match(settingsHtml, /mirrorUrl\.searchParams\.set\("mirror", "1"\);/);
  assert.match(settingsHtml, /broadcastStatusLayoutCommand\("auto-arrange", \{\}\);/);
  assert.match(settingsHtml, /bellforge-status-layout-command/);
  assert.doesNotMatch(settingsHtml, /Target display 320x240 \| Modal viewport 320x240/);
});

test('status card registry is complete and default priorities match the default readable layout', () => {
  const statusKeys = extractCardKeys(statusHtml);
  assert.deepEqual(statusKeys, [
    'hero',
    'browser-links',
    'onboarding-qr',
    'stats',
    'advanced',
  ]);
  assert.match(statusHtml, /defaultPriorities:\s*\{[\s\S]*hero: 10,[\s\S]*"browser-links": 8,[\s\S]*"onboarding-qr": 7,[\s\S]*stats: 6,[\s\S]*advanced: 4,/);
});

test('token changes and layout events trigger reflow hooks', () => {
  assert.match(settingsHtml, /settingsAdaptiveLayout\.recompute\(\);/);
  assert.match(statusHtml, /statusAdaptiveLayout\.recompute\(\);/);
  assert.match(sharedLayoutSource, /default layout generation/);
  assert.match(sharedLayoutSource, /card reflow events/);
});

test('resolution selection prefers the active or largest real display mode over tiny fallback modes', () => {
  const xrandrOutput = [
    'Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 8192 x 8192',
    'HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 476mm x 268mm',
    '   320x240      60.00',
    '   1920x1080    60.00*+',
  ].join('\n');
  const candidates = layout.extractResolutionCandidatesFromText(xrandrOutput);
  assert.deepEqual(layout.pickBestResolution(candidates), { width: 1920, height: 1080 });
});

test('default layout snapshots remain stable for settings, status, and preview', () => {
  const settingsSnapshot = computeSnapshot(settingsCards, { tracks: 10, maxPerRow: 3, rowUnit: 8, preferImportance: true });
  const statusSnapshot = computeSnapshot(statusCards, { tracks: 5, maxPerRow: 2, rowUnit: 8, preferImportance: true });
  const previewSnapshot = computeSnapshot(statusCards, { tracks: 5, maxPerRow: 2, rowUnit: 8, preferImportance: true });

  assert.deepEqual(settingsSnapshot, snapshots.settings);
  assert.deepEqual(statusSnapshot, snapshots.status);
  assert.deepEqual(previewSnapshot, snapshots.preview);
});