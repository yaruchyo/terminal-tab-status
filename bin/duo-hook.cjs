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

const FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
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

function writeTitle(text) {
  if (ttyFd === null) return;
  try {
    const safe = sanitize(text);
    fs.writeSync(ttyFd, `\x1b]2;${safe}\x07\x1b]0;${safe}\x07`);
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
  writeTitle(`${FRAMES[0]} ${currentTitle}`);
  spinnerInterval = setInterval(() => {
    frameIndex = (frameIndex + 1) % FRAMES.length;
    writeTitle(`${FRAMES[frameIndex]} ${currentTitle}`);
  }, 100);
  unref(spinnerInterval);
}

function showDone() {
  stopSpinner();
  writeTitle(`\u2713 ${currentTitle}`);
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
  if (name === currentTitle || name === `\u2713 ${currentTitle}`) return true;
  if (name.includes(currentTitle)) return true;
  const stripped = name.replace(/^[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F\u2713] /, "");
  if (stripped === currentTitle || stripped.startsWith(currentTitle)) return true;
  if (name.includes(" \u2014 ")) {
    for (const seg of name.split(" \u2014 ")) {
      if (seg.trim() === currentTitle || currentTitle.startsWith(seg.trim())) return true;
    }
  }
  const ti = stripped.indexOf("\u2026");
  if (ti > 0 && currentTitle.startsWith(stripped.substring(0, ti))) return true;
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

// --- Intercept fs.writeSync (CJS module is mutable) ---
const origWriteSync = fs.writeSync;
fs.writeSync = function patchedWriteSync(fd) {
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

    // Detect OSC 0 title
    const m = data.match(/\x1b\]0;([^\x07]*)\x07/);
    if (m && m[1] && m[1] !== "GitLab Duo CLI" && m[1] !== "") {
      currentTitle = m[1];
      if (state === "idle") writeTitle(currentTitle);
    }
  }

  return origWriteSync.apply(fs, arguments);
};

// --- Intercept stderr.write for title (ChatInterface.tsx writes via stderr) ---
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
