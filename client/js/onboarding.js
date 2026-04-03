"use strict";

const BASE = window.BELLFORGE_SERVER_URL || window.location.origin;
const ACCESS_KEY = "bellforge.access_token";
const REFRESH_KEY = "bellforge.refresh_token";

const els = {
  deviceName: document.getElementById("device-name"),
  deviceFingerprint: document.getElementById("device-fingerprint"),
  deviceNetwork: document.getElementById("device-network"),
  userToken: document.getElementById("user-token"),
  claimOrg: document.getElementById("claim-org"),
  claimClassroom: document.getElementById("claim-classroom"),
  claimCode: document.getElementById("claim-code"),
  pairingCode: document.getElementById("pairing-code"),
  pairingToken: document.getElementById("pairing-token"),
  pairingQr: document.getElementById("pairing-qr"),
  status: document.getElementById("onboarding-status"),
  statusResult: document.getElementById("status-result"),
};

let currentPairingToken = "";
let pollTimer = null;

function saveSessionTokens(payload) {
  if (payload && payload.access_token) {
    localStorage.setItem(ACCESS_KEY, payload.access_token);
    els.userToken.value = payload.access_token;
  }
  if (payload && payload.refresh_token) {
    localStorage.setItem(REFRESH_KEY, payload.refresh_token);
  }
}

function getAccessToken() {
  const typed = els.userToken.value.trim();
  if (typed) {
    localStorage.setItem(ACCESS_KEY, typed);
    return typed;
  }
  return localStorage.getItem(ACCESS_KEY) || "";
}

function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY) || "";
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? "#9b2f2f" : "#114a70";
}

function authHeaders() {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Sign in first on /auth from this browser.");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function refreshSessionToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  const response = await fetch(`${BASE}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) {
    return false;
  }
  const payload = await response.json();
  saveSessionTokens(payload);
  return true;
}

async function apiJson(path, method, body, headers = { "Content-Type": "application/json" }) {
  const doFetch = (requestHeaders) =>
    fetch(`${BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

  let response = await doFetch(headers);
  if (response.status === 401 && headers.Authorization) {
    const refreshed = await refreshSessionToken();
    if (refreshed) {
      response = await doFetch(authHeaders());
    }
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload && payload.detail ? JSON.stringify(payload.detail) : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

function updateQr(pairingToken) {
  const src = `${BASE}/api/devices/pairing/qr-svg?pairing_token=${encodeURIComponent(pairingToken)}`;
  els.pairingQr.src = src;
}

async function createPairingSession() {
  setStatus("Creating pairing session...");
  try {
    const payload = await apiJson("/api/devices/pairing/init", "POST", {
      device_name: els.deviceName.value.trim(),
      device_fingerprint: els.deviceFingerprint.value.trim(),
      network_id: els.deviceNetwork.value.trim() || null,
    });
    currentPairingToken = payload.pairing_token;
    els.pairingCode.textContent = payload.pairing_code;
    els.claimCode.value = payload.pairing_code;
    els.pairingToken.textContent = payload.pairing_token;
    els.statusResult.textContent = JSON.stringify(payload, null, 2);
    updateQr(payload.pairing_token);
    setStatus(`Pairing code ready. Expires in ${payload.pairing_code_expires_in}s.`);
  } catch (error) {
    setStatus(`Pairing init failed: ${error.message}`, true);
  }
}

async function claimByCode() {
  setStatus("Claiming by pairing code...");
  try {
    const payload = await apiJson(
      "/api/devices/pairing/claim-code",
      "POST",
      {
        pairing_code: els.claimCode.value.trim(),
        org_id: els.claimOrg.value.trim() || null,
        classroom_id: els.claimClassroom.value.trim() || null,
      },
      authHeaders()
    );
    els.statusResult.textContent = JSON.stringify(payload, null, 2);
    setStatus("Pairing code claimed. Check status from device side.");
  } catch (error) {
    setStatus(`Claim by code failed: ${error.message}`, true);
  }
}

async function claimByQr() {
  setStatus("Claiming by QR token...");
  try {
    const token = currentPairingToken || els.pairingToken.textContent.trim();
    const payload = await apiJson(
      "/api/devices/pairing/claim-qr",
      "POST",
      {
        pairing_token: token,
        org_id: els.claimOrg.value.trim() || null,
        classroom_id: els.claimClassroom.value.trim() || null,
      },
      authHeaders()
    );
    els.statusResult.textContent = JSON.stringify(payload, null, 2);
    setStatus("QR payload claimed. Check status from device side.");
  } catch (error) {
    setStatus(`Claim by QR failed: ${error.message}`, true);
  }
}

async function checkStatus() {
  try {
    const token = currentPairingToken || els.pairingToken.textContent.trim();
    const payload = await apiJson("/api/devices/pairing/status", "POST", {
      pairing_token: token,
      device_fingerprint: els.deviceFingerprint.value.trim(),
    });
    els.statusResult.textContent = JSON.stringify(payload, null, 2);
    if (payload.paired) {
      setStatus("Device paired successfully. Device token issued.");
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } else {
      setStatus(`Pairing status: ${payload.status}`);
    }
  } catch (error) {
    setStatus(`Status check failed: ${error.message}`, true);
  }
}

function togglePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    setStatus("Polling stopped.");
    return;
  }
  setStatus("Polling pairing status every 3 seconds...");
  pollTimer = setInterval(checkStatus, 3000);
}

async function copyPairingToken() {
  const text = currentPairingToken || els.pairingToken.textContent.trim();
  if (!text || text.includes("appears here")) {
    setStatus("No pairing token to copy yet.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Pairing token copied to clipboard.");
  } catch (_) {
    setStatus("Clipboard copy failed in this browser context.", true);
  }
}

document.getElementById("pairing-init").addEventListener("click", createPairingSession);
document.getElementById("copy-token").addEventListener("click", copyPairingToken);
document.getElementById("claim-code-btn").addEventListener("click", claimByCode);
document.getElementById("claim-qr-btn").addEventListener("click", claimByQr);
document.getElementById("status-btn").addEventListener("click", checkStatus);
document.getElementById("poll-btn").addEventListener("click", togglePolling);

const params = new URLSearchParams(window.location.search);
const fromUrlToken = params.get("pairing_token") || "";
const fromUrlCode = params.get("pairing_code") || "";
if (fromUrlToken) {
  currentPairingToken = fromUrlToken;
  els.pairingToken.textContent = fromUrlToken;
  updateQr(fromUrlToken);
  setStatus("Pairing session loaded from QR link.");
}
if (fromUrlCode) {
  els.claimCode.value = fromUrlCode;
  els.pairingCode.textContent = fromUrlCode;
}

const cachedAccess = localStorage.getItem(ACCESS_KEY) || "";
if (cachedAccess) {
  els.userToken.value = cachedAccess;
}
