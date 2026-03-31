/**
 * BellForge Signage Client
 *
 * Displays the current time, active period, countdown to next bell, and
 * upcoming periods. Schedule and version data are fetched from the BellForge
 * backend. Falls back to cached data if the server is unreachable.
 */

"use strict";

// ---------------------------------------------------------------------------
// Configuration — override SERVER_URL in config.js or via meta tag if needed
// ---------------------------------------------------------------------------

const CONFIG = {
  /** Base URL of the BellForge FastAPI backend. */
  serverUrl: window.BELLFORGE_SERVER_URL || "http://bellforge-server.local:8000",

  /** How often to re-fetch the schedule from the server (ms). */
  schedulePollInterval: 5 * 60 * 1000,

  /** How often to check for a new version (ms). */
  versionPollInterval: 60 * 1000,

  /** Number of upcoming periods to show in the footer. */
  upcomingCount: 5,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let schedule = null;      // Full schedule object from /api/schedule
let versionInfo = null;   // Version object from /api/version
let isOnline = true;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

const elTime       = $("time-display");
const elDate       = $("date-display");
const elSchoolName = $("school-name");
const elPeriodName = $("period-name");
const elPeriodTime = $("period-time");
const elPeriodDot  = $("period-dot");
const elCountText  = $("countdown-text");
const elCountLeft  = $("countdown-remaining");
const elFill       = $("progress-fill");
const elFooter     = $("footer");
const elConn       = $("conn-indicator");
const elVersion    = $("version-display");
const elDevice     = $("device-display");

// ---------------------------------------------------------------------------
// Time utilities
// ---------------------------------------------------------------------------

/** Parse "HH:MM" string into total minutes since midnight. */
function parseMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

/** Format total minutes since midnight as "H:MM AM/PM". */
function formatMinutes(totalMin) {
  const h24 = Math.floor(totalMin / 60);
  const m   = totalMin % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12  = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Format seconds into "Xm Ys" or "Xs". */
function formatCountdown(totalSec) {
  if (totalSec <= 0) return "now";
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0
    ? `${m}m ${String(s).padStart(2, "0")}s`
    : `${s}s`;
}

/** Get current local time as total minutes since midnight. */
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// ---------------------------------------------------------------------------
// Schedule logic
// ---------------------------------------------------------------------------

/** Return the period currently active, or null if outside all periods. */
function currentPeriod(nowMin, periods) {
  return periods.find(p =>
    nowMin >= parseMinutes(p.start) && nowMin < parseMinutes(p.end)
  ) || null;
}

/** Return the next period that hasn't started yet. */
function nextPeriod(nowMin, periods) {
  return periods.find(p => parseMinutes(p.start) > nowMin) || null;
}

/** Return the N periods starting from the next one after now. */
function upcomingPeriods(nowMin, periods, count) {
  return periods.filter(p => parseMinutes(p.start) > nowMin).slice(0, count);
}

// ---------------------------------------------------------------------------
// Display update — called every second
// ---------------------------------------------------------------------------

function tick() {
  const now  = new Date();
  const nowM = nowMinutes();

  // Clock
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  elTime.textContent = `${h}:${m}:${s}`;

  // Date
  elDate.textContent = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  if (!schedule) return;

  const periods = schedule.periods;
  const active  = currentPeriod(nowM, periods);
  const next    = nextPeriod(nowM, periods);

  // Current period
  if (active) {
    elPeriodName.textContent = active.name;
    elPeriodTime.textContent = `${formatMinutes(parseMinutes(active.start))} – ${formatMinutes(parseMinutes(active.end))}`;
    elPeriodDot.className    = active.type === "break" ? "break" : active.type === "passing" ? "passing" : "";

    // Countdown to end of current period
    const endMin      = parseMinutes(active.end);
    const durationSec = (parseMinutes(active.end) - parseMinutes(active.start)) * 60;
    const remainSec   = Math.max(0, Math.round((endMin - nowM) * 60));
    const elapsed     = durationSec - remainSec;
    const pct         = durationSec > 0 ? Math.min(100, (elapsed / durationSec) * 100) : 0;

    elCountText.textContent  = `Ends in`;
    elCountLeft.textContent  = formatCountdown(remainSec);
    elFill.style.width       = `${pct}%`;
  } else if (next) {
    elPeriodName.textContent = "Between Periods";
    elPeriodTime.textContent = `Next: ${next.name} at ${formatMinutes(parseMinutes(next.start))}`;
    elPeriodDot.className    = "passing";

    const startsSec         = Math.round((parseMinutes(next.start) - nowM) * 60);
    elCountText.textContent  = `${next.name} starts in`;
    elCountLeft.textContent  = formatCountdown(Math.max(0, startsSec));
    elFill.style.width       = "0%";
  } else {
    elPeriodName.textContent = "School Day Complete";
    elPeriodTime.textContent = "";
    elPeriodDot.className    = "";
    elCountText.textContent  = "See you tomorrow!";
    elCountLeft.textContent  = "";
    elFill.style.width       = "100%";
  }

  // Upcoming footer cards
  const upcoming = upcomingPeriods(nowM, periods, CONFIG.upcomingCount);
  elFooter.innerHTML = upcoming.map((p, i) => `
    <div class="upcoming-card${i === 0 ? " next-up" : ""}">
      <div class="upcoming-card-name">${escHtml(p.name)}</div>
      <div class="upcoming-card-time">${formatMinutes(parseMinutes(p.start))} – ${formatMinutes(parseMinutes(p.end))}</div>
    </div>
  `).join("");
}

/** Minimal HTML escaping to prevent XSS from server-provided strings. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchSchedule() {
  try {
    const resp = await fetch(`${CONFIG.serverUrl}/api/schedule`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    schedule = await resp.json();

    // Apply school name
    if (schedule.school_name) {
      elSchoolName.textContent = schedule.school_name;
      document.title = schedule.school_name;
    }

    setOnlineStatus(true);
  } catch (err) {
    console.warn("Schedule fetch failed:", err);
    setOnlineStatus(false);
    // Keep using cached schedule if available
  }
}

async function fetchVersion() {
  try {
    const resp = await fetch(`${CONFIG.serverUrl}/api/version`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    versionInfo = await resp.json();
    elVersion.textContent = `v${versionInfo.version}`;
  } catch (err) {
    // Non-fatal — version display stays stale
  }
}

function setOnlineStatus(online) {
  isOnline = online;
  elConn.textContent  = online ? "● ONLINE" : "● OFFLINE";
  elConn.className    = online ? "" : "offline";
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Show device ID if embedded in the page (injected by bootstrap)
  const deviceId = document.querySelector('meta[name="bellforge-device"]')?.content;
  if (deviceId) elDevice.textContent = deviceId;

  // Initial data load
  await Promise.allSettled([fetchSchedule(), fetchVersion()]);

  // Clock tick every second
  setInterval(tick, 1000);
  tick();

  // Periodic re-fetches
  setInterval(fetchSchedule, CONFIG.schedulePollInterval);
  setInterval(fetchVersion,  CONFIG.versionPollInterval);
}

boot();
