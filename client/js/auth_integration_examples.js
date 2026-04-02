"use strict";

/*
 * BellForge auth integration examples for:
 * - Web app login
 * - Browser extension login
 * - Token refresh + auto-reconnect
 *
 * These are examples only. Keep provider SDK setup in each host app.
 */

const BellForgeAuth = (() => {
  const ACCESS_KEY = "bellforge.access_token";
  const REFRESH_KEY = "bellforge.refresh_token";
  const BASE_URL = window.BELLFORGE_SERVER_URL || "http://127.0.0.1:8000";

  function saveTokens(tokens) {
    localStorage.setItem(ACCESS_KEY, tokens.access_token);
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
  }

  function getAccessToken() {
    return localStorage.getItem(ACCESS_KEY);
  }

  function getRefreshToken() {
    return localStorage.getItem(REFRESH_KEY);
  }

  function clearTokens() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
    });

    if (response.status !== 401) {
      return response;
    }

    const refreshed = await refresh();
    if (!refreshed) {
      clearTokens();
      return response;
    }

    const retryHeaders = new Headers(options.headers || {});
    retryHeaders.set("Content-Type", "application/json");
    retryHeaders.set("Authorization", `Bearer ${getAccessToken()}`);
    return fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: retryHeaders,
    });
  }

  async function login(provider, providerIdToken, clientType = "web") {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        id_token: providerIdToken,
        client_type: clientType,
      }),
    });

    if (!response.ok) {
      throw new Error(`Login failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    saveTokens(payload);
    return payload;
  }

  async function refresh() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    const response = await fetch(`${BASE_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) return false;
    const payload = await response.json();
    saveTokens(payload);
    return true;
  }

  async function logout() {
    const refreshToken = getRefreshToken();
    await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAccessToken() || ""}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    clearTokens();
  }

  async function registerDevice(deviceName, deviceFingerprint, orgId, classroomId) {
    const response = await api("/api/devices/register", {
      method: "POST",
      body: JSON.stringify({
        device_name: deviceName,
        device_fingerprint: deviceFingerprint,
        org_id: orgId,
        classroom_id: classroomId,
      }),
    });
    if (!response.ok) throw new Error(`Device registration failed: HTTP ${response.status}`);
    return response.json();
  }

  return {
    api,
    login,
    logout,
    refresh,
    registerDevice,
    getAccessToken,
    getRefreshToken,
    clearTokens,
  };
})();

/*
 * Browser extension notes (Manifest V3):
 * - Store tokens in chrome.storage.local instead of localStorage.
 * - Exchange provider token from chrome.identity.launchWebAuthFlow against /api/auth/login.
 * - Use the same refresh pattern in background service worker.
 */
async function extensionLoginExample(provider, providerIdToken) {
  const response = await fetch("http://127.0.0.1:8000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, id_token: providerIdToken, client_type: "extension" }),
  });
  if (!response.ok) throw new Error("Extension login failed.");
  const payload = await response.json();
  await chrome.storage.local.set({
    bellforgeAccessToken: payload.access_token,
    bellforgeRefreshToken: payload.refresh_token,
  });
}
