"use strict";

const BASE = window.BELLFORGE_SERVER_URL || "http://127.0.0.1:8000";
const ACCESS_KEY = "bellforge.access_token";
const REFRESH_KEY = "bellforge.refresh_token";

const elStatus = document.getElementById("automode-status");
const elPending = document.getElementById("pending-list");
const elDiscovered = document.getElementById("discovered-list");
const elHistory = document.getElementById("history-list");

function authHeaders() {
  const access = localStorage.getItem(ACCESS_KEY) || "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${access}`,
  };
}

async function refreshSessionToken() {
  const refreshToken = localStorage.getItem(REFRESH_KEY) || "";
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
  if (payload.access_token) {
    localStorage.setItem(ACCESS_KEY, payload.access_token);
  }
  if (payload.refresh_token) {
    localStorage.setItem(REFRESH_KEY, payload.refresh_token);
  }
  return true;
}

async function authFetch(path, options = {}) {
  const execute = (headers) =>
    fetch(`${BASE}${path}`, {
      ...options,
      headers,
    });

  let response = await execute(authHeaders());
  if (response.status === 401) {
    const refreshed = await refreshSessionToken();
    if (refreshed) {
      response = await execute(authHeaders());
    }
  }
  return response;
}

async function activateAutoMode() {
  const controllerId = document.getElementById("controller-id").value.trim();
  const networkId = document.getElementById("network-id").value.trim();
  const response = await authFetch("/api/automode/activate", {
    method: "POST",
    body: JSON.stringify({ controller_device_id: controllerId, network_id: networkId }),
  });
  if (!response.ok) {
    elStatus.textContent = `Activation failed: HTTP ${response.status}`;
    return;
  }
  const payload = await response.json();
  elStatus.textContent = `AutoMode active on ${payload.controller_device_id}`;
  await Promise.all([loadPending(), loadHistory()]);
}

async function loadPending() {
  const response = await authFetch("/api/automode/pending");
  if (!response.ok) {
    elPending.innerHTML = `<p>Unable to load pending: HTTP ${response.status}</p>`;
    return;
  }
  const payload = await response.json();
  const pending = payload.pending || [];

  elDiscovered.innerHTML = pending
    .map(item => `<li>${item.discovered_device_name} <span class="pill">${item.network_id}</span></li>`)
    .join("") || "<li>No devices discovered.</li>";

  elPending.innerHTML = pending
    .map(item => `
      <div style="border:1px solid #d9dfdf;border-radius:10px;padding:0.6rem;margin-bottom:0.55rem;">
        <div><strong>${item.discovered_device_name}</strong> (${item.discovered_fingerprint})</div>
        <div style="margin-top:0.4rem;display:flex;gap:0.4rem;flex-wrap:wrap;">
          <button data-approve="${item.id}">Approve</button>
          <button class="danger" data-deny="${item.id}">Deny</button>
        </div>
      </div>
    `)
    .join("") || "<p>No pending approvals.</p>";

  elPending.querySelectorAll("button[data-approve]").forEach(button => {
    button.addEventListener("click", () => decide(button.getAttribute("data-approve"), true));
  });
  elPending.querySelectorAll("button[data-deny]").forEach(button => {
    button.addEventListener("click", () => decide(button.getAttribute("data-deny"), false));
  });
}

async function decide(pendingId, approve) {
  const response = await authFetch("/api/automode/decide", {
    method: "POST",
    body: JSON.stringify({
      pending_id: pendingId,
      approve,
      org_id: "default-org",
      classroom_id: "default-classroom",
    }),
  });
  if (!response.ok) {
    alert(`Decision failed: HTTP ${response.status}`);
    return;
  }
  await Promise.all([loadPending(), loadHistory()]);
}

async function loadHistory() {
  const response = await authFetch("/api/automode/history");
  if (!response.ok) {
    elHistory.innerHTML = `<li>Unable to load history: HTTP ${response.status}</li>`;
    return;
  }
  const payload = await response.json();
  const history = payload.history || [];
  elHistory.innerHTML = history
    .slice(0, 30)
    .map(item => `<li>${item.discovered_device_name} -> ${item.status} (${item.decided_at || item.created_at})</li>`)
    .join("") || "<li>No history yet.</li>";
}

document.getElementById("activate-automode").addEventListener("click", activateAutoMode);
document.getElementById("refresh-pending").addEventListener("click", loadPending);
document.getElementById("refresh-history").addEventListener("click", loadHistory);

loadPending();
loadHistory();
