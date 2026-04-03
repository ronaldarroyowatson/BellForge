"use strict";

const BASE = window.BELLFORGE_SERVER_URL || window.location.origin;

const els = {
  provider: document.getElementById("provider"),
  providerSubject: document.getElementById("provider-subject"),
  providerEmail: document.getElementById("provider-email"),
  localEmail: document.getElementById("local-email"),
  localPassword: document.getElementById("local-password"),
  localName: document.getElementById("local-name"),
  tokenAccess: document.getElementById("token-access"),
  tokenRefresh: document.getElementById("token-refresh"),
  output: document.getElementById("auth-output"),
};

let lastResetToken = "";

function show(value) {
  els.output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function api(path, method, body, headers = { "Content-Type": "application/json" }) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload ? JSON.stringify(payload) : `HTTP ${response.status}`);
  }
  return payload;
}

function stashTokens(payload) {
  if (payload && payload.access_token) {
    els.tokenAccess.value = payload.access_token;
    localStorage.setItem("bellforge.access_token", payload.access_token);
  }
  if (payload && payload.refresh_token) {
    els.tokenRefresh.value = payload.refresh_token;
    localStorage.setItem("bellforge.refresh_token", payload.refresh_token);
  }
}

async function cloudLogin() {
  const provider = els.provider.value;
  const subject = els.providerSubject.value.trim();
  const email = els.providerEmail.value.trim();
  const payload = await api("/api/auth/login", "POST", {
    provider,
    id_token: `stub:${provider}:${subject}:${email}`,
    client_type: "web",
  });
  stashTokens(payload);
  show(payload);
}

async function verifyAccessToken() {
  const token = els.tokenAccess.value.trim();
  const payload = await api("/api/auth/verify", "POST", { token });
  show(payload);
}

async function localRegister() {
  const payload = await api("/api/auth/local/register", "POST", {
    email: els.localEmail.value.trim(),
    password: els.localPassword.value,
    name: els.localName.value.trim(),
    client_type: "web",
  });
  stashTokens(payload);
  show(payload);
}

async function localLogin() {
  const payload = await api("/api/auth/local/login", "POST", {
    email: els.localEmail.value.trim(),
    password: els.localPassword.value,
    client_type: "web",
  });
  stashTokens(payload);
  show(payload);
}

async function localResetRequest() {
  const payload = await api("/api/auth/local/password-reset/request", "POST", {
    email: els.localEmail.value.trim(),
  });
  lastResetToken = payload.reset_token || "";
  show(payload);
}

async function localResetConfirm() {
  if (!lastResetToken) {
    show("No reset token captured yet. Run reset request first.");
    return;
  }
  const payload = await api("/api/auth/local/password-reset/confirm", "POST", {
    reset_token: lastResetToken,
    new_password: `${els.localPassword.value}-new`,
  });
  show(payload);
}

async function refreshSession() {
  const payload = await api("/api/auth/refresh", "POST", {
    refresh_token: els.tokenRefresh.value.trim(),
  });
  stashTokens(payload);
  show(payload);
}

async function logoutSession() {
  const access = els.tokenAccess.value.trim();
  const refresh = els.tokenRefresh.value.trim();
  const payload = await api(
    "/api/auth/logout",
    "POST",
    { refresh_token: refresh || null },
    {
      "Content-Type": "application/json",
      Authorization: access ? `Bearer ${access}` : "",
    }
  );
  show(payload);
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    show(`Request failed: ${error.message}`);
  }
}

document.getElementById("cloud-login").addEventListener("click", () => run(cloudLogin));
document.getElementById("verify-token").addEventListener("click", () => run(verifyAccessToken));
document.getElementById("local-register").addEventListener("click", () => run(localRegister));
document.getElementById("local-login").addEventListener("click", () => run(localLogin));
document.getElementById("local-reset-request").addEventListener("click", () => run(localResetRequest));
document.getElementById("local-reset-confirm").addEventListener("click", () => run(localResetConfirm));
document.getElementById("refresh-session").addEventListener("click", () => run(refreshSession));
document.getElementById("logout-session").addEventListener("click", () => run(logoutSession));

const cachedAccess = localStorage.getItem("bellforge.access_token") || "";
const cachedRefresh = localStorage.getItem("bellforge.refresh_token") || "";
els.tokenAccess.value = cachedAccess;
els.tokenRefresh.value = cachedRefresh;
