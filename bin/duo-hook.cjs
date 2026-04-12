/**
 * Duo CLI hook — injected via NODE_OPTIONS="--require"
 *
 * Intercepts fs.writeSync to detect TerminalProgressService's OSC 9;4 sequences,
 * and stderr.write to capture session title. Overlays spinner/checkmark via /dev/tty.
 *
 * No modifications to Duo CLI source required.
 * Setup: export NODE_OPTIONS="${NODE_OPTIONS} --require ~/.config/opencode/bin/duo-hook.cjs"
 */
"use strict";

const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");

// Only activate for Duo CLI processes
const argv = process.argv.join(" ");
const isLikelyDuo =
  argv.includes("duo-cli") ||
  argv.includes("@gitlab/duo-cli") ||
  (process.env._ && (process.env._.endsWith("/duo") || process.env._.includes("duo-cli")));

if (!isLikelyDuo) return;

// Save the ORIGINAL fs.writeSync BEFORE any patching
const _origWriteSync = fs.writeSync;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const home = process.env.HOME || "";
const activeTabBin = [
  path.join(home, ".config", "opencode", "bin", "active-terminal-tab"),
  path.join(home, ".opencode", "bin", "active-terminal-tab"),
].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;

let currentTitle = "GitLab Duo CLI";
let state = "idle"; // idle | busy | done
let spinnerInterval = null;
let focusPollInterval = null;
let frameIndex = 0;
let ttyFd = null;

try {
  ttyFd = fs.openSync("/dev/tty", "w");
} catch {
  // No TTY
}

function sanitize(text) {
  return text.replace(/[\x00-\x1f\x7f]/g, "");
}

// Write title using the ORIGINAL writeSync — never goes through our interceptor
function writeTitle(text) {
  if (ttyFd === null) return;
  try {
    const safe = sanitize(text);
    _origWriteSync(ttyFd, `\x1b]2;${safe}\x07\x1b]0;${safe}\x07`);
  } catch { /* ignore */ }
}

function stopSpinner() {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
}

function stopFocusPoll() {
  if (focusPollInterval) { clearInterval(focusPollInterval); focusPollInterval = null; }
}

function unref(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}

function startSpinner() {
  stopSpinner();
  frameIndex = 0;
  writeTitle(FRAMES[0] + " " + currentTitle);
  spinnerInterval = setInterval(() => {
    frameIndex = (frameIndex + 1) % FRAMES.length;
    writeTitle(FRAMES[frameIndex] + " " + currentTitle);
  }, 100);
  unref(spinnerInterval);
}

function showDone() {
  stopSpinner();
  writeTitle("✓ " + currentTitle);
  startFocusPoll();
}

function showPlain() {
  stopSpinner();
  stopFocusPoll();
  writeTitle(currentTitle);
}

function getActiveTabName() {
  return new Promise((resolve) => {
    if (!activeTabBin) { resolve(""); return; }
    execFile(activeTabBin, { timeout: 500 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

function isOurTabActive(name) {
  if (!name) return false;
  const title = currentTitle;
  const checkTitle = "✓ " + title;

  function matches(candidate) {
    if (candidate === title || candidate === checkTitle) return true;
    if (candidate.startsWith(title) || candidate.startsWith(checkTitle)) return true;
    const ti = candidate.indexOf("…");
    if (ti > 0) {
      const prefix = candidate.substring(0, ti);
      if (title.startsWith(prefix) || checkTitle.startsWith(prefix)) return true;
    }
    return false;
  }

  if (matches(name)) return true;

  // Strip spinner/checkmark prefix
  const stripped = name.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓] /, "");
  if (stripped !== name && matches(stripped)) return true;

  // Terminal.app: "user — title — process — WxH"
  if (name.includes(" — ")) {
    for (const seg of name.split(" — ")) {
      if (matches(seg.trim())) return true;
    }
  }

  // Substring
  if (name.includes(title)) return true;

  return false;
}

function startFocusPoll() {
  stopFocusPoll();
  if (!activeTabBin) return;
  focusPollInterval = setInterval(async () => {
    if (state !== "done") { stopFocusPoll(); return; }
    try {
      const active = await getActiveTabName();
      if (isOurTabActive(active)) { state = "idle"; showPlain(); }
    } catch { /* ignore */ }
  }, 500);
  unref(focusPollInterval);
}

// --- Intercept fs.writeSync to detect TerminalProgressService's OSC 9;4 ---
// IMPORTANT: we use _origWriteSync (saved above) in writeTitle() so our own
// title writes never trigger this interceptor — preventing infinite recursion.
fs.writeSync = function patchedWriteSync(fd) {
  // Skip interception for our own ttyFd writes
  if (fd === ttyFd) {
    return _origWriteSync.apply(this, arguments);
  }

  const data = arguments[1];
  if (typeof data === "string") {
    // Detect OSC 9;4 from TerminalProgressService
    if (data.includes("9;4;3")) {
      if (state !== "busy") { state = "busy"; startSpinner(); }
    } else if (data.includes("9;4;0")) {
      if (state === "busy") {
        state = "done";
        getActiveTabName().then((active) => {
          if (state !== "done") return;
          if (isOurTabActive(active)) { state = "idle"; showPlain(); }
          else { showDone(); }
        }).catch(() => { showDone(); });
      }
    } else if (data.includes("9;4;2")) {
      if (state === "busy") { state = "idle"; showPlain(); }
    }
  }

  return _origWriteSync.apply(this, arguments);
};

// --- Intercept stderr.write to capture session title ---
const origStderrWrite = process.stderr.write;
process.stderr.write = function patchedWrite(chunk) {
  const str = typeof chunk === "string" ? chunk : (chunk && chunk.toString ? chunk.toString() : "");
  const m = str.match(/\x1b\]0;([^\x07]*)\x07/);
  if (m && m[1] && m[1] !== "GitLab Duo CLI" && m[1] !== "") {
    currentTitle = m[1];
    if (state === "idle") writeTitle(currentTitle);
  }
  return origStderrWrite.apply(process.stderr, arguments);
};

// Cleanup
process.on("exit", () => {
  stopSpinner();
  stopFocusPoll();
  if (ttyFd !== null) { try { fs.closeSync(ttyFd); } catch {} }
});
