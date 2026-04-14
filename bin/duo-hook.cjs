/**
 * Duo CLI hook — injected via NODE_OPTIONS="--require"
 *
 * Intercepts fs.writeSync to detect TerminalProgressService's OSC 9;4 sequences,
 * and stderr.write to capture session title. Overlays spinner/checkmark via /dev/tty.
 *
 * SECURITY: This module is loaded into every Node.js process via NODE_OPTIONS.
 * It MUST bail out immediately for non-Duo processes. The detection is strict:
 * only activates when process.argv[1] points to a @gitlab/duo-cli package.
 *
 * No modifications to Duo CLI source required.
 * Setup: export NODE_OPTIONS="${NODE_OPTIONS} --require ~/.config/opencode/bin/duo-hook.cjs"
 */
"use strict";

// --- Strict Duo CLI detection ---
// SECURITY: Must not false-positive on npm, web servers, build tools, etc.
// Only activate when the main script is inside a @gitlab/duo-cli package.
// process.env._ is NOT used — it inherits into child processes and is unreliable.
const mainScript = (process.argv[1] || "");
const isDuoCli =
  mainScript.includes("@gitlab/duo-cli") ||
  mainScript.includes("duo-cli/dist/") ||
  mainScript.includes("duo-cli/src/");

if (!isDuoCli) return;

const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");

// Save the ORIGINAL fs.writeSync BEFORE any patching
const _origWriteSync = fs.writeSync;

// Full OSC 9;4 sequence prefixes for precise matching.
// TerminalProgressService writes: \x1b]9;4;CODE\x1b\\  or tmux-wrapped variant.
// We check for the ESC]9;4; prefix to avoid false matches on arbitrary strings.
const OSC_BUSY  = "\x1b]9;4;3";   // indeterminate progress
const OSC_IDLE  = "\x1b]9;4;0";   // clear progress
const OSC_ERROR = "\x1b]9;4;2";   // error
// Tmux variant: \x1bPtmux;\x1b\x1b]9;4;CODE...
const TMUX_OSC_BUSY  = "\x1b\x1b]9;4;3";
const TMUX_OSC_IDLE  = "\x1b\x1b]9;4;0";
const TMUX_OSC_ERROR = "\x1b\x1b]9;4;2";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FOCUS_POLL_MAX_MS = 5 * 60 * 1000; // Stop polling after 5 minutes
const home = process.env.HOME || "";
const activeTabBin = [
  path.join(home, ".config", "opencode", "bin", "active-terminal-tab"),
].find((p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; }
  catch { return false; }
}) || null;

let currentTitle = "GitLab Duo CLI";
let state = "idle"; // idle | busy | done
let spinnerInterval = null;
let focusPollInterval = null;
let focusPollStart = 0;
let frameIndex = 0;
let ttyFd = null;

try {
  ttyFd = fs.openSync("/dev/tty", "w");
} catch {
  // No TTY — all title operations will no-op
}

/**
 * Strip C0 control characters (\x00-\x1f, \x7f) AND C1 control characters
 * (\u0080-\u009f) to prevent any terminal escape sequence injection.
 * C1 chars matter because some terminals interpret U+009B as CSI (= \x1b[).
 */
function sanitize(text) {
  return text.replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, "");
}

// Write title using the ORIGINAL writeSync — bypasses our interceptor entirely
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
  focusPollStart = Date.now();
  focusPollInterval = setInterval(async () => {
    // Stop after max duration to prevent indefinite polling
    if (state !== "done" || Date.now() - focusPollStart > FOCUS_POLL_MAX_MS) {
      stopFocusPoll();
      return;
    }
    try {
      const active = await getActiveTabName();
      if (isOurTabActive(active)) { state = "idle"; showPlain(); }
    } catch { /* ignore */ }
  }, 500);
  unref(focusPollInterval);
}

/**
 * Check if a string contains an OSC 9;4 sequence (normal or tmux-wrapped).
 * Returns the status code character ('0','2','3','4') or null.
 */
function detectOscProgress(data) {
  // Normal: \x1b]9;4;CODE
  let idx = data.indexOf("\x1b]9;4;");
  if (idx !== -1) return data[idx + 6] || null;
  // Tmux: \x1b\x1b]9;4;CODE
  idx = data.indexOf("\x1b\x1b]9;4;");
  if (idx !== -1) return data[idx + 7] || null;
  return null;
}

// --- Intercept fs.writeSync to detect TerminalProgressService's OSC 9;4 ---
fs.writeSync = function patchedWriteSync(fd) {
  // Skip our own ttyFd — writeTitle() uses _origWriteSync directly,
  // but this is a safety net in case of any other code path
  if (fd === ttyFd) {
    return _origWriteSync.apply(this, arguments);
  }

  const data = arguments[1];
  if (typeof data === "string" && data.length < 200) {
    // Only check short strings — OSC sequences are <50 bytes.
    // This avoids scanning large data buffers (file writes, HTTP responses).
    const code = detectOscProgress(data);
    if (code === "3") {
      // Busy (indeterminate progress)
      if (state !== "busy") { state = "busy"; startSpinner(); }
    } else if (code === "0") {
      // Idle (clear progress)
      if (state === "busy") {
        state = "done";
        getActiveTabName().then((active) => {
          if (state !== "done") return;
          if (isOurTabActive(active)) { state = "idle"; showPlain(); }
          else { showDone(); }
        }).catch(() => { showDone(); });
      }
    } else if (code === "2") {
      // Error
      if (state === "busy") { state = "idle"; showPlain(); }
    }
  }

  return _origWriteSync.apply(this, arguments);
};

// --- Intercept stderr.write to capture session title ---
const origStderrWrite = process.stderr.write;
process.stderr.write = function patchedWrite(chunk) {
  if (typeof chunk === "string" && chunk.length < 500) {
    // Only check short writes — title OSC sequences are small
    const m = chunk.match(/\x1b\]0;([^\x07]*)\x07/);
    if (m && m[1] && m[1] !== "GitLab Duo CLI" && m[1] !== "") {
      currentTitle = m[1];
      if (state === "idle") writeTitle(currentTitle);
    }
  }
  return origStderrWrite.apply(process.stderr, arguments);
};

// Cleanup
process.on("exit", () => {
  stopSpinner();
  stopFocusPoll();
  if (ttyFd !== null) { try { fs.closeSync(ttyFd); } catch {} }
});
