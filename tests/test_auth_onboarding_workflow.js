const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerBrowserSuite,
  openPage,
  STATUS_PATH,
} = require('./layout_browser_harness.js');

const suite = registerBrowserSuite();

test('status page unauthenticated flow routes into settings authentication card onboarding workflow', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const statusPage = await openPage(context, STATUS_PATH, 'auth-gate-status-route', { allowEmpty: true });

    await statusPage.page.click('#layoutEditToggle');
    await statusPage.page.waitForURL('**/settings**', { timeout: 30000 });

    const route = await statusPage.page.evaluate(() => ({
      pathname: window.location.pathname,
      search: window.location.search,
    }));

    assert.ok(
      route.pathname === '/settings',
      `Expected settings auth route, received ${route.pathname}${route.search}`,
    );
    assert.match(route.search, /auth_required=1/, 'Expected auth-required settings route');
    assert.match(route.search, /auth_reason=status-layout-toggle/, 'Expected status edit auth reason');
  } finally {
    await context.close();
  }
});

test('legacy onboarding route redirects to settings authentication card', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const onboarding = await openPage(context, '/onboarding', 'legacy-onboarding-redirect', { allowEmpty: true });
    await onboarding.page.waitForURL('**/settings**', { timeout: 30000 });
    const current = onboarding.page.url();
    assert.match(current, /\/settings\?/, 'Expected onboarding route redirect to settings');
    assert.match(current, /auth_required=1/, 'Expected auth-required query on onboarding redirect');
  } finally {
    await context.close();
  }
});

test('settings auth card local workflow does not open duplicate tabs', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=local', 'settings-auth-inline-local', { allowEmpty: true });
    let popupCount = 0;
    settings.page.on('popup', () => {
      popupCount += 1;
    });

    await settings.page.waitForSelector('#authLocalEmail', { state: 'visible', timeout: 30000 });

    const nonce = Date.now();
    await settings.page.fill('#authLocalEmail', `workflow-${nonce}@example.com`);
    await settings.page.fill('#authLocalPassword', `workflow-password-${nonce}-abc`);
    await settings.page.fill('#authLocalName', `Workflow User ${nonce}`);
    await settings.page.click('#authLocalRegisterBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authLocalResult')?.textContent || '';
      return text.toLowerCase().includes('succeeded');
    }, { timeout: 30000 });

    assert.equal(popupCount, 0, 'Settings auth-card local workflow must not open popup tabs');
  } finally {
    await context.close();
  }
});
