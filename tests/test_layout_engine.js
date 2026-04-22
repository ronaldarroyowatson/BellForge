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
  { key: 'setup-hero', priority: 10, weight: 10, height: 420 },
  { key: 'quick-facts', priority: 9, weight: 9, height: 300 },
  { key: 'browser-links', priority: 8, weight: 8, height: 320 },
  { key: 'onboarding-qr', priority: 7, weight: 7, height: 340 },
  { key: 'stats', priority: 6, weight: 6, height: 240 },
  { key: 'advanced', priority: 4, weight: 4, height: 300 },
];

test('collapse/expand shrinks to title-only height and stays in the same masonry column', () => {
  const expanded = computeSnapshot([
    { key: 'primary', priority: 9, weight: 9, height: 320 },
    { key: 'secondary', priority: 4, weight: 4, height: 200 },
  ], { tracks: 2, rowUnit: 8 });
  const collapsed = computeSnapshot([
    { key: 'primary', priority: 9, weight: 9, height: 56, collapsed: true },
    { key: 'secondary', priority: 4, weight: 4, height: 200 },
  ], { tracks: 2, rowUnit: 8 });

  assert.equal(collapsed[0].key, 'primary');
  assert.equal(collapsed[0].colSpan, expanded[0].colSpan);
  assert.ok(collapsed[0].rowSpan < expanded[0].rowSpan);
  assert.ok(collapsed.some((item) => item.key === 'primary'));
});

test('masonry layout keeps cards single-column while preserving insertion order', () => {
  const snapshot = computeSnapshot([
    { key: 'first', height: 200 },
    { key: 'second', height: 260 },
    { key: 'third', height: 180 },
  ], { tracks: 2, rowUnit: 8 });

  assert.deepEqual(snapshot.map((item) => item.key), ['first', 'second', 'third']);
  assert.ok(snapshot.every((item) => item.colSpan === 1));
});

test('shortest-column placement balances column heights', () => {
  const snapshot = computeSnapshot([
    { key: 'alpha', height: 320 },
    { key: 'beta', height: 180 },
    { key: 'gamma', height: 180 },
    { key: 'delta', height: 320 },
  ], { tracks: 2, rowUnit: 8 });

  assert.equal(snapshot.find((item) => item.key === 'alpha')?.colStart, 1);
  assert.equal(snapshot.find((item) => item.key === 'beta')?.colStart, 2);
  assert.equal(snapshot.find((item) => item.key === 'gamma')?.colStart, 2);
  assert.equal(snapshot.find((item) => item.key === 'delta')?.colStart, 1);
});

test('cards reorder by content weight and priority on default layout generation', () => {
  const snapshot = computeSnapshot([
    { key: 'light', priority: 1, weight: 1, height: 140 },
    { key: 'heavy', priority: 8, weight: 8, height: 260 },
    { key: 'medium', priority: 4, weight: 4, height: 220 },
  ], { tracks: 3, rowUnit: 8 });

  assert.deepEqual(snapshot.map((item) => item.key), ['light', 'heavy', 'medium']);
});

test('layout packs cards into available masonry columns', () => {
  const snapshot = computeSnapshot(settingsCards, { tracks: 3, rowUnit: 8 });
  assert.ok(snapshot.every((item) => item.colSpan === 1));
  assert.ok(snapshot.every((item) => item.colStart >= 1 && item.colStart <= 3));
});

test('expanding a card pushes cards below it out of the way and collapsing pulls them upward', () => {
  const collapsed = computeSnapshot([
    { key: 'setup-hero', priority: 10, weight: 10, height: 56, collapsed: true },
    { key: 'quick-facts', priority: 9, weight: 9, height: 300 },
    { key: 'browser-links', priority: 8, weight: 8, height: 320 },
    { key: 'onboarding-qr', priority: 7, weight: 7, height: 340 },
    { key: 'stats', priority: 6, weight: 6, height: 240 },
    { key: 'advanced', priority: 4, weight: 4, height: 300 },
  ], { tracks: 2, rowUnit: 8 });

  const expanded = computeSnapshot(statusCards, { tracks: 2, rowUnit: 8 });

  const collapsedBrowserLinks = collapsed.find((item) => item.key === 'browser-links');
  const expandedBrowserLinks = expanded.find((item) => item.key === 'browser-links');
  const collapsedStats = collapsed.find((item) => item.key === 'stats');
  const expandedStats = expanded.find((item) => item.key === 'stats');
  assert.ok(expandedBrowserLinks.rowStart > collapsedBrowserLinks.rowStart);
  assert.ok(expandedStats.rowStart > collapsedStats.rowStart);
});

test('no card overlaps another after autolayout packing', () => {
  const snapshot = computeSnapshot(settingsCards, { tracks: 3, rowUnit: 8 });
  for (let index = 0; index < snapshot.length; index += 1) {
    for (let compare = index + 1; compare < snapshot.length; compare += 1) {
      assert.equal(rectanglesOverlap(snapshot[index], snapshot[compare]), false, `${snapshot[index].key} overlaps ${snapshot[compare].key}`);
    }
  }
});

test('responsive track resolver reflows across breakpoints', () => {
  const resolver = layout.createDefaultTrackResolver('settings');
  assert.deepEqual(resolver(500), { tracks: 1, minCardWidth: 320, gap: 12 });
  assert.deepEqual(resolver(900), { tracks: 2, minCardWidth: 320, gap: 12 });
  assert.deepEqual(resolver(1300), { tracks: 3, minCardWidth: 320, gap: 12 });
  assert.deepEqual(resolver(900, { layoutMode: 'landscape' }), { tracks: 2, minCardWidth: 300, gap: 12 });
  assert.deepEqual(resolver(1300, { layoutMode: 'landscape' }), { tracks: 4, minCardWidth: 300, gap: 12 });
});

test('track metric helper computes stable column counts from viewport width, card width, and gap', () => {
  assert.deepEqual(layout.computeTrackMetrics(1280, 300, 12), {
    width: 1280,
    minCardWidth: 300,
    gap: 12,
    tracks: 4,
  });
  assert.deepEqual(layout.computeTrackMetrics(760, 320, 24), {
    width: 760,
    minCardWidth: 320,
    gap: 24,
    tracks: 2,
  });
});

test('viewport frame helper distinguishes physical-display and preview scaling rules', () => {
  const liveFrame = layout.computeViewportFrame({
    source: 'physical-display',
    baseWidth: 1920,
    baseHeight: 1080,
    availableWidth: 2560,
    availableHeight: 1440,
    layoutWidth: 1920,
    layoutHeight: 1080,
    allowGrow: false,
  });
  const previewFrame = layout.computeViewportFrame({
    source: 'preview-remote-browser',
    baseWidth: 1920,
    baseHeight: 1080,
    availableWidth: 2560,
    availableHeight: 1440,
    layoutWidth: 2560,
    layoutHeight: 1440,
    allowGrow: true,
  });

  assert.equal(liveFrame.renderWidth, 1920);
  assert.equal(liveFrame.renderHeight, 1080);
  assert.equal(liveFrame.layoutWidth, 1920);
  assert.equal(previewFrame.layoutWidth, 2560);
  assert.equal(previewFrame.renderWidth, 2560);
  assert.ok(previewFrame.scale > liveFrame.scale);
});

test('auto-arrange helper produces deterministic row-major order for the same viewport inputs', () => {
  const entries = [
    descriptor({ key: 'hero', priority: 9, weight: 9, height: 420 }, 0),
    descriptor({ key: 'links', priority: 8, weight: 8, height: 260 }, 1),
    descriptor({ key: 'stats', priority: 7, weight: 7, height: 240 }, 2),
    descriptor({ key: 'advanced', priority: 4, weight: 4, height: 180 }, 3),
  ];
  const first = layout.computeAutoArrangeOrder(entries, { tracks: 2, rowUnit: 8, gap: 12 });
  const second = layout.computeAutoArrangeOrder(entries, { tracks: 2, rowUnit: 8, gap: 12 });
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['hero', 'links', 'stats', 'advanced']);
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

test('settings hosts the real embedded status preview surface and links to the real status pages', () => {
  assert.match(settingsHtml, /id="openStatusPage"/);
  assert.match(settingsHtml, /id="openDisplayStatusPage"/);
  assert.match(settingsHtml, /id="designStatusPreviewFrame"/);
  assert.match(settingsHtml, /embedded preview uses the same status layout engine/i);
  assert.match(settingsHtml, /window\.__bellforgeStatusPreview/);
});

test('status page exposes explicit save and preview editor hooks for shared layout persistence', () => {
  assert.match(statusHtml, /id="layoutSave"/);
  assert.match(statusHtml, /const REMOTE_LAYOUT_POLL_MS = 2000;/);
  assert.match(statusHtml, /fetch\("\/api\/display\/status-layout"/);
  assert.match(statusHtml, /persistSharedStatusLayout/);
  assert.match(statusHtml, /isPreviewEditor/);
});

test('status card registry is complete and default priorities match the default readable layout', () => {
  const statusKeys = extractCardKeys(statusHtml);
  assert.deepEqual(statusKeys, [
    'setup-hero',
    'quick-facts',
    'browser-links',
    'onboarding-qr',
    'stats',
    'advanced',
  ]);
  assert.match(statusHtml, /defaultPriorities:\s*\{[\s\S]*"browser-links": 10,[\s\S]*"onboarding-qr": 9,[\s\S]*stats: 8,[\s\S]*advanced: 7,[\s\S]*"setup-hero": 6,[\s\S]*"quick-facts": 5,/);
  assert.match(statusHtml, /document\.documentElement\.dataset\.designLayoutMode = layoutMode/);
  assert.match(settingsHtml, /<select id="designLayoutMode">[\s\S]*<option value="portrait">Portrait<\/option>[\s\S]*<option value="landscape">Landscape<\/option>/);
});

test('token changes and layout events trigger reflow hooks', () => {
  assert.match(settingsHtml, /settingsAdaptiveLayout\.(?:requestLayout|recompute)\(/);
  assert.match(statusHtml, /statusAdaptiveLayout\.(?:requestLayout|recompute)\(/);
  assert.match(sharedLayoutSource, /masonry decisions/);
  assert.match(sharedLayoutSource, /masonry reflow/);
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

test('default layout snapshots remain stable for settings and status masonry plans', () => {
  const settingsSnapshot = computeSnapshot(settingsCards, { tracks: 3, rowUnit: 8 });
  const statusSnapshot = computeSnapshot(statusCards, { tracks: 2, rowUnit: 8 });

  assert.ok(Array.isArray(snapshots.settings));
  assert.ok(Array.isArray(snapshots.status));
  assert.equal(settingsSnapshot.length, settingsCards.length);
  assert.equal(statusSnapshot.length, statusCards.length);
  assert.ok(settingsSnapshot.every((item) => item.colSpan === 1));
  assert.ok(statusSnapshot.every((item) => item.colSpan === 1));
});