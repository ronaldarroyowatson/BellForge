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

test('settings auth card clears stale authenticating state when token verification fails', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=local', 'settings-auth-stale-authenticating-recovery', { allowEmpty: true });

    await settings.page.evaluate(() => {
      localStorage.setItem('bellforge.auth.machine_state.v1', JSON.stringify({
        state: 'authenticating',
        userIdentity: { email: 'rarroyo-watson@tulsaacademy.org', provider: 'local' },
        reason: '',
        updatedAt: new Date().toISOString(),
      }));
      localStorage.removeItem('bellforge.access_token');
      localStorage.removeItem('bellforge.refresh_token');
    });

    await settings.page.reload({ waitUntil: 'domcontentloaded' });

    await settings.page.waitForFunction(() => {
      const statusText = document.getElementById('authStateMessage')?.textContent || '';
      const tokenState = document.getElementById('authTokenState')?.textContent || '';
      const stored = JSON.parse(localStorage.getItem('bellforge.auth.machine_state.v1') || '{}');
      return !/in progress/i.test(statusText)
        && !/validating/i.test(tokenState)
        && stored.state !== 'authenticating';
    }, { timeout: 30000 });

    const authCardState = await settings.page.evaluate(() => ({
      statusMessage: document.getElementById('authStateMessage')?.textContent?.trim() || '',
      tokenState: document.getElementById('authTokenState')?.textContent?.trim() || '',
        machine: JSON.parse(localStorage.getItem('bellforge.auth.machine_state.v1') || '{}'),
    }));

    assert.doesNotMatch(authCardState.statusMessage, /in progress/i, 'Authentication card remained in in-progress state after token verification failed');
    assert.doesNotMatch(authCardState.tokenState, /validating/i, 'Authentication token state remained validating after token verification failed');
    assert.notEqual(authCardState.machine.state, 'authenticating', 'Auth machine persisted stale authenticating state');
  } finally {
    await context.close();
  }
});

test('settings refresh recovers from invalid access token via refresh token', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=local', 'settings-auth-refresh-token-recovery', { allowEmpty: true });
    await settings.page.waitForSelector('#authLocalEmail', { state: 'visible', timeout: 30000 });

    const nonce = Date.now();
    const email = `refresh-recovery-${nonce}@example.com`;
    const password = `refresh-recovery-${nonce}-password`;

    await settings.page.fill('#authLocalEmail', email);
    await settings.page.fill('#authLocalPassword', password);
    await settings.page.fill('#authLocalName', `Refresh Recovery ${nonce}`);
    await settings.page.click('#authLocalRegisterBtn');

    await settings.page.waitForFunction(() => {
      const authStatus = document.getElementById('authStatus')?.textContent?.trim() || '';
      const tokenState = document.getElementById('authTokenState')?.textContent?.trim() || '';
      return authStatus === 'Healthy' && tokenState === 'Valid';
    }, { timeout: 30000 });

    await settings.page.evaluate(() => {
      localStorage.setItem('bellforge.access_token', 'expired.invalid.token');
    });

    await settings.page.click('#authUsersRefreshBtn');

    await settings.page.waitForFunction(() => {
      const accessToken = localStorage.getItem('bellforge.access_token') || '';
      const authStatus = document.getElementById('authStatus')?.textContent?.trim() || '';
      const tokenState = document.getElementById('authTokenState')?.textContent?.trim() || '';
      return accessToken !== 'expired.invalid.token' && authStatus === 'Healthy' && tokenState === 'Valid';
    }, { timeout: 30000 });

    const tokenState = await settings.page.evaluate(() => ({
      accessToken: localStorage.getItem('bellforge.access_token') || '',
      refreshToken: localStorage.getItem('bellforge.refresh_token') || '',
      authStatus: document.getElementById('authStatus')?.textContent?.trim() || '',
      authTokenState: document.getElementById('authTokenState')?.textContent?.trim() || '',
    }));

    assert.notEqual(tokenState.accessToken, 'expired.invalid.token', 'Access token was not repaired from refresh token flow');
    assert.ok(tokenState.refreshToken.length > 0, 'Refresh token should still be present after token recovery');
    assert.equal(tokenState.authStatus, 'Healthy', 'Auth status did not recover after token refresh');
    assert.equal(tokenState.authTokenState, 'Valid', 'Token state did not recover after token refresh');
  } finally {
    await context.close();
  }
});

test('settings switches local auth to returning-login mode when local account exists', async () => {
  const context = await suite.newContext({ width: 1280, height: 720 });

  try {
    const settings = await openPage(context, '/settings?auth_required=1&start_onboarding=1&auth_workflow=local', 'settings-auth-returning-login-mode', { allowEmpty: true });
    await settings.page.waitForSelector('#authLocalEmail', { state: 'visible', timeout: 30000 });

    const nonce = Date.now();
    await settings.page.fill('#authLocalEmail', `returning-mode-${nonce}@example.com`);
    await settings.page.fill('#authLocalPassword', `returning-mode-${nonce}-password`);
    await settings.page.fill('#authLocalName', `Returning Mode ${nonce}`);
    await settings.page.click('#authLocalRegisterBtn');

    await settings.page.waitForFunction(() => {
      const text = document.getElementById('authLocalResult')?.textContent || '';
      return text.toLowerCase().includes('login successful');
    }, { timeout: 30000 });

    await settings.page.evaluate(() => {
      localStorage.removeItem('bellforge.access_token');
      localStorage.removeItem('bellforge.refresh_token');
    });

    await settings.page.reload({ waitUntil: 'domcontentloaded' });

    await settings.page.waitForFunction(() => {
      const onboarding = document.getElementById('authBeginOnboarding');
      const loginBtn = document.getElementById('authLocalLoginBtn');
      return Boolean(onboarding) && Boolean(loginBtn)
        && onboarding.hidden === true
        && !loginBtn.classList.contains('secondary');
    }, { timeout: 30000 });

    const uiState = await settings.page.evaluate(() => ({
      onboardingHidden: Boolean(document.getElementById('authBeginOnboarding')?.hidden),
      loginIsPrimary: !document.getElementById('authLocalLoginBtn')?.classList.contains('secondary'),
    }));

    assert.equal(uiState.onboardingHidden, true, 'Onboarding CTA should hide when local returning-login mode is active');
    assert.equal(uiState.loginIsPrimary, true, 'Login button should be promoted to primary action for returning local users');
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
