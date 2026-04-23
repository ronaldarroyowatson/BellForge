/**
 * BellForge Control Server client module.
 *
 * Handles device role management, LAN server discovery, and layout-edit
 * permission checks against the BellForge backend.
 *
 * Usage
 * -----
 *   import { BellForgeControlServer } from '/client/js/control_server.js';
 *   // or as a plain script:
 *   //   <script src="/client/js/control_server.js"></script>
 *   //   window.BellForgeControlServer.getStatus()
 *
 * All methods return Promises that resolve to plain objects matching the
 * backend response shapes, or reject with an Error whose .message describes
 * the failure.
 */
"use strict";

(function (global) {
  const BASE = global.BELLFORGE_SERVER_URL || (typeof window !== "undefined" ? window.location.origin : "");

  /**
   * Retrieve the stored access token from localStorage.
   * @returns {string} token or empty string
   */
  function _getAccessToken() {
    try {
      return localStorage.getItem("bellforge.access_token") || "";
    } catch {
      return "";
    }
  }

  /**
   * Build an Authorization header object when a token is available.
   * @returns {Record<string, string>}
   */
  function _authHeaders() {
    const token = _getAccessToken();
    const base = { "Content-Type": "application/json" };
    return token ? { ...base, Authorization: `Bearer ${token}` } : base;
  }

  /**
   * Generic JSON fetch wrapper.
   * @param {string} path - path starting with /api/...
   * @param {string} method
   * @param {object|null} body
   * @param {boolean} requiresAuth
   * @returns {Promise<object>}
   */
  async function _json(path, method = "GET", body = null, requiresAuth = false) {
    const headers = requiresAuth ? _authHeaders() : { "Content-Type": "application/json" };
    const init = { method, headers };
    if (body !== null && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${BASE}${path}`, init);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const msg =
        (payload && (payload.message || (payload.detail && (payload.detail.message || payload.detail)))) ||
        `HTTP ${response.status}`;
      throw new Error(String(msg));
    }
    return payload;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the current device role and server metadata.
   * @returns {Promise<{role: string, device_id: string, device_name: string, updated_at: string, [key: string]: any}>}
   */
  async function getStatus() {
    return _json("/api/control/status");
  }

  /**
   * Probe the LAN for other BellForge control servers.
   * Blocks for up to the backend discovery timeout (~3 s).
   * @returns {Promise<{servers: Array<{address: string, device_id: string, device_name: string}>, count: number}>}
   */
  async function discoverServers() {
    return _json("/api/control/discover");
  }

  /**
   * Promote this device to control-server role.
   * Requires a valid user access token in localStorage.
   * @param {string} deviceName
   * @returns {Promise<object>}
   */
  async function promoteToServer(deviceName) {
    if (!deviceName || !deviceName.trim()) {
      throw new Error("deviceName is required.");
    }
    return _json("/api/control/promote", "POST", { device_name: deviceName.trim() }, true);
  }

  /**
   * Join an existing control server as a satellite.
   * @param {{serverAddress: string, serverDeviceId: string, serverDeviceName: string, serverUserId: string}} params
   * @returns {Promise<object>}
   */
  async function joinAsSatellite({ serverAddress, serverDeviceId, serverDeviceName, serverUserId }) {
    if (!serverAddress) throw new Error("serverAddress is required.");
    if (!serverUserId) throw new Error("serverUserId is required.");
    return _json("/api/control/join", "POST", {
      server_address: serverAddress,
      server_device_id: serverDeviceId || "",
      server_device_name: serverDeviceName || "",
      server_user_id: serverUserId,
    });
  }

  /**
   * Reset this device's role back to UNCONFIGURED.
   * Requires a valid user access token in localStorage.
   * @returns {Promise<object>}
   */
  async function resetRole() {
    return _json("/api/control/reset", "POST", {}, true);
  }

  /**
   * Check whether the authenticated user may edit the status-page layout.
   * Requires a valid user access token in localStorage.
   * @returns {Promise<{permitted: boolean, role: string, reason: string}>}
   */
  async function checkLayoutEditPermission() {
    return _json("/api/control/permissions/layout-edit", "GET", null, true);
  }

  /**
   * Full onboarding flow helper.
   *
   * Steps performed:
   *  1. Verify access token is present.
   *  2. Discover servers on LAN.
   *  3a. If servers found → return them for the caller to confirm joining.
   *  3b. If no servers found → return indication that this device can become server.
   *
   * @param {string} deviceName
   * @returns {Promise<{
   *   hasToken: boolean,
   *   serversFound: Array<{address: string, device_id: string, device_name: string}>,
   *   canBecomeServer: boolean,
   *   discoveryComplete: boolean
   * }>}
   */
  async function runDiscoveryPhase(deviceName) {
    const hasToken = Boolean(_getAccessToken());
    let serversFound = [];
    let discoveryComplete = false;
    try {
      const result = await discoverServers();
      serversFound = Array.isArray(result.servers) ? result.servers : [];
      discoveryComplete = true;
    } catch {
      discoveryComplete = false;
    }
    return {
      hasToken,
      serversFound,
      canBecomeServer: discoveryComplete && serversFound.length === 0 && hasToken,
      discoveryComplete,
    };
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  const BellForgeControlServer = {
    getStatus,
    discoverServers,
    promoteToServer,
    joinAsSatellite,
    resetRole,
    checkLayoutEditPermission,
    runDiscoveryPhase,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = BellForgeControlServer;
  } else {
    global.BellForgeControlServer = BellForgeControlServer;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
