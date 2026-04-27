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
      const normalized = text.toLowerCase();
      return normalized.includes('succeeded') || normalized.includes('login successful');
    }, { timeout: 30000 });

    assert.equal(popupCount, 0, 'Settings auth-card local workflow must not open popup tabs');
  } finally {
    await context.close();
  }
});

test('settings local register blocks short passwords before sending request', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=local', 'settings-auth-local-short-password-validation', { allowEmpty: true });
    await settings.page.waitForSelector('#authLocalEmail', { state: 'visible', timeout: 30000 });

    let registerRequestCount = 0;
    settings.page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/auth/local/register')) {
        registerRequestCount += 1;
      }
    });

    const nonce = Date.now();
    await settings.page.fill('#authLocalEmail', `shortpass-${nonce}@example.com`);
    await settings.page.fill('#authLocalPassword', 'short');
    await settings.page.fill('#authLocalName', `Short Pass ${nonce}`);

    const requirementStateBefore = await settings.page.evaluate(() => {
      const minLength = document.querySelector('#authLocalPasswordRequirements [data-rule="min-length"]');
      return {
        exists: Boolean(minLength),
        met: Boolean(minLength?.classList.contains('is-met')),
      };
    });
    assert.equal(requirementStateBefore.exists, true, 'Password requirements checklist should be visible in local auth panel');
    assert.equal(requirementStateBefore.met, false, 'Min-length requirement should be unmet for short password input');

    await settings.page.click('#authLocalRegisterBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authLocalResult')?.textContent || '';
      return /at least 10 characters/i.test(text);
    }, { timeout: 30000 });

    await settings.page.fill('#authLocalPassword', 'long-enough-password-123');
    const requirementStateAfter = await settings.page.evaluate(() => {
      const minLength = document.querySelector('#authLocalPasswordRequirements [data-rule="min-length"]');
      return Boolean(minLength?.classList.contains('is-met'));
    });
    assert.equal(requirementStateAfter, true, 'Min-length requirement should be marked met after long-enough password input');

    assert.equal(registerRequestCount, 0, 'Short password must be blocked client-side before calling local register API');
  } finally {
    await context.close();
  }
});

test('settings authentication card supports login to promotion to layout-unlock flow', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=local', 'settings-auth-to-server-flow', { allowEmpty: true });
    await settings.page.waitForSelector('#authLocalEmail', { state: 'visible', timeout: 30000 });

    const nonce = Date.now();
    const email = `promote-${nonce}@example.com`;
    const password = `promote-password-${nonce}-xyz`;

    await settings.page.fill('#authLocalEmail', email);
    await settings.page.fill('#authLocalPassword', password);
    await settings.page.fill('#authLocalName', `Promote User ${nonce}`);
    await settings.page.click('#authLocalRegisterBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authLocalResult')?.textContent || '';
      return text.includes('Login successful');
    }, { timeout: 30000 });

    await settings.page.waitForFunction(() => {
      const authStatus = document.getElementById('authStatus')?.textContent?.trim() || '';
      const tokenState = document.getElementById('authTokenState')?.textContent?.trim() || '';
      return authStatus === 'Healthy' && tokenState === 'Valid';
    }, { timeout: 30000 });

    await settings.page.click('#authOpenServer');
    await settings.page.click('#authServerPromoteBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authServerResult')?.textContent || '';
      return text.includes('This device is the server');
    }, { timeout: 30000 });

    const state = await settings.page.evaluate(async () => {
      const token = localStorage.getItem('bellforge.access_token') || '';
      const permissionResponse = await fetch('/api/control/permissions/layout-edit', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const permission = await permissionResponse.json();
      return {
        authIdentity: document.getElementById('authIdentity')?.textContent?.trim() || '',
        authStatus: document.getElementById('authStatus')?.textContent?.trim() || '',
        serverRole: document.getElementById('authServerRole')?.textContent?.trim() || '',
        permission,
      };
    });

    assert.equal(state.authStatus, 'Healthy', 'Authentication card did not remain healthy after promotion');
    assert.match(state.authIdentity, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Authentication card did not show authenticated user');
    assert.match(state.serverRole, /server/i, 'Authentication card did not show server role after promotion');
    assert.equal(state.permission.permitted, true, 'Layout editing did not unlock for authenticated server user');
    assert.equal(state.permission.role, 'server', 'Permission endpoint did not reflect server role after promotion');
  } finally {
    await context.close();
  }
});

test('settings server promotion is blocked while unauthenticated', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=server', 'settings-promote-blocked-unauthenticated', { allowEmpty: true });

    await settings.page.waitForSelector('#authServerPromoteBtn', { state: 'visible', timeout: 30000 });
    await settings.page.click('#authServerPromoteBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authServerResult')?.textContent || '';
      return text.toLowerCase().includes('blocked: authenticate first');
    }, { timeout: 30000 });

    const resultText = await settings.page.locator('#authServerResult').innerText();
    assert.match(resultText, /authenticate first/i, 'Expected promotion blocking message for unauthenticated state');
  } finally {
    await context.close();
  }
});

test('regular settings local login refreshes users and can promote server without onboarding wizard', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings', 'settings-regular-login-refresh-promote', { allowEmpty: true });

    await settings.page.evaluate(() => {
      window.__bellforgeSettingsLayout?.setCardCollapsed?.('authentication', false, 'test-regular-local-login');
    });

    await settings.page.click('#authOpenLocal');
    await settings.page.waitForSelector('#authLocalEmail', { state: 'visible', timeout: 30000 });

    const nonce = Date.now();
    const email = `regular-${nonce}@example.com`;
    await settings.page.fill('#authLocalEmail', email);
    await settings.page.fill('#authLocalPassword', 'admin-pass-123');
    await settings.page.fill('#authLocalName', 'admin');
    await settings.page.click('#authLocalRegisterBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authLocalResult')?.textContent || '';
      return text.toLowerCase().includes('login successful');
    }, { timeout: 30000 });

    await settings.page.click('#authUsersRefreshBtn');
    await settings.page.waitForFunction((expectedEmail) => {
      const usersText = document.getElementById('authUserList')?.textContent || '';
      return usersText.includes(expectedEmail);
    }, email, { timeout: 30000 });

    await settings.page.click('#authOpenServer');
    await settings.page.click('#authServerPromoteBtn');
    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authServerResult')?.textContent || '';
      return text.includes('This device is the server');
    }, { timeout: 30000 });
  } finally {
    await context.close();
  }
});

test('settings cloud auth surfaces error code when provider is not configured', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=federated', 'settings-cloud-auth-error-code', { allowEmpty: true });
    await settings.page.waitForSelector('#authInlineCloud', { state: 'visible', timeout: 30000 });
    await settings.page.waitForSelector('#authCloudProvider', { state: 'visible', timeout: 30000 });

    await settings.page.selectOption('#authCloudProvider', 'microsoft');
    const nonce = Date.now();
    await settings.page.fill('#authCloudSubject', `scienceteacher-${nonce}`);
    await settings.page.fill('#authCloudEmail', `scienceteacher-${nonce}@example.com`);

    await settings.page.click('#authCloudLoginBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authCloudResult')?.textContent || '';
      return text.toLowerCase().includes('cloud') && (
        text.toLowerCase().includes('failed') ||
        text.toLowerCase().includes('error') ||
        text.toLowerCase().includes('not configured')
      );
    }, { timeout: 30000 });

    const resultText = await settings.page.locator('#authCloudResult').innerText();
    assert.match(
      resultText,
      /\[code:\s*provider_not_configured\]/i,
      `Cloud auth result must include error code when provider is not configured; got: "${resultText}"`,
    );
  } finally {
    await context.close();
  }
});
