/**
 * Duo CLI hook — injected via NODE_OPTIONS="--import"
 *
 * Intercepts fs.writeSync calls to detect TerminalProgressService's
 * OSC 9;4 sequences on /dev/tty, then overlays spinner/checkmark.
 *
 * How it works:
 * - TerminalProgressService opens /dev/tty and writes OSC 9;4 sequences:
 *     Busy:   \x1b]9;4;3\x1b\\
 *     Idle:   \x1b]9;4;0\x1b\\
 *     Error:  \x1b]9;4;2\x1b\\
 *     Paused: \x1b]9;4;4;50\x1b\\
 * - ChatInterface.tsx writes the session title via stderr:
 *     \x1b]0;<title>\x07
 * - We intercept both to track state and title, then write our enhanced
 *   title (with spinner/checkmark) via our own /dev/tty fd.
 *
 * No modifications to Duo CLI source required.
 * Installed via: export NODE_OPTIONS="--import ~/.config/opencode/bin/duo-hook.mjs"
 */

import { openSync, writeSync, closeSync, existsSync } from "fs"
import { execFile } from "child_process"
import { join } from "path"
import * as fs from "fs"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// Only activate for duo CLI processes
const isDuo = process.argv.some(
  (arg) => arg.includes("@gitlab/duo-cli") || arg.includes("duo-cli") || arg.endsWith("/index.js"),
)
// Also check if being run from the duo launcher
const isLikelyDuo = process.env._ && (process.env._.endsWith("/duo") || process.env._.includes("duo-cli"))

if (!isDuo && !isLikelyDuo) {
  // Not a Duo CLI process, don't activate
} else {
  // --- State ---
  let currentTitle = "GitLab Duo CLI"
  let state: "idle" | "busy" | "done" = "idle"
  let spinnerInterval: ReturnType<typeof setInterval> | null = null
  let focusPollInterval: ReturnType<typeof setInterval> | null = null
  let frameIndex = 0
  let ttyFd: number | null = null

  // Find the active-terminal-tab binary
  const home = process.env.HOME || ""
  const activeTabBin = [
    join(home, ".config", "opencode", "bin", "active-terminal-tab"),
    join(home, ".opencode", "bin", "active-terminal-tab"),
  ].find((p) => existsSync(p)) || null

  // Open our own /dev/tty fd (separate from TerminalProgressService's)
  try {
    ttyFd = openSync("/dev/tty", "w")
  } catch {
    // No TTY, silently disable
  }

  function sanitize(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x1f\x7f]/g, "")
  }

  function writeTitle(text: string) {
    if (ttyFd === null) return
    try {
      const safe = sanitize(text)
      writeSync(ttyFd, `\x1b]2;${safe}\x07\x1b]0;${safe}\x07`)
    } catch {
      // ignore
    }
  }

  function stopSpinner() {
    if (spinnerInterval) {
      clearInterval(spinnerInterval)
      spinnerInterval = null
    }
  }

  function stopFocusPoll() {
    if (focusPollInterval) {
      clearInterval(focusPollInterval)
      focusPollInterval = null
    }
  }

  function unref(interval: ReturnType<typeof setInterval>) {
    if (interval && typeof interval === "object" && "unref" in interval) {
      ;(interval as NodeJS.Timeout).unref()
    }
  }

  function startSpinner() {
    stopSpinner()
    frameIndex = 0
    writeTitle(`${FRAMES[0]} ${currentTitle}`)
    spinnerInterval = setInterval(() => {
      frameIndex = (frameIndex + 1) % FRAMES.length
      writeTitle(`${FRAMES[frameIndex]} ${currentTitle}`)
    }, 100)
    unref(spinnerInterval)
  }

  function showDone() {
    stopSpinner()
    writeTitle(`✓ ${currentTitle}`)
    startFocusPoll()
  }

  function showPlain() {
    stopSpinner()
    stopFocusPoll()
    writeTitle(currentTitle)
  }

  function getActiveTabName(): Promise<string> {
    return new Promise((resolve) => {
      if (!activeTabBin) { resolve(""); return }
      execFile(activeTabBin, { timeout: 500 }, (err, stdout) => {
        resolve(err ? "" : stdout.trim())
      })
    })
  }

  function isOurTabActive(name: string): boolean {
    if (!name) return false
    if (name === currentTitle || name === `✓ ${currentTitle}`) return true
    if (name.includes(currentTitle)) return true
    const stripped = name.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓] /, "")
    if (stripped === currentTitle || stripped.startsWith(currentTitle)) return true
    if (name.includes(" \u2014 ")) {
      for (const seg of name.split(" \u2014 ")) {
        if (seg.trim() === currentTitle || currentTitle.startsWith(seg.trim())) return true
      }
    }
    const truncIdx = stripped.indexOf("\u2026")
    if (truncIdx > 0 && currentTitle.startsWith(stripped.substring(0, truncIdx))) return true
    return false
  }

  function startFocusPoll() {
    stopFocusPoll()
    if (!activeTabBin) return
    focusPollInterval = setInterval(async () => {
      if (state !== "done") { stopFocusPoll(); return }
      try {
        const active = await getActiveTabName()
        if (isOurTabActive(active)) { state = "idle"; showPlain() }
      } catch { /* ignore */ }
    }, 500)
    unref(focusPollInterval)
  }

  // --- Intercept fs.writeSync to detect TerminalProgressService writes ---
  const origWriteSync = fs.writeSync as (...args: unknown[]) => number
  ;(fs as any).writeSync = function patchedWriteSync(fd: number, ...args: unknown[]) {
    const data = args[0]
    if (typeof data === "string") {
      // Detect OSC 9;4 sequences from TerminalProgressService
      if (data.includes("9;4;3")) {
        // Busy
        if (state !== "busy") {
          state = "busy"
          startSpinner()
        }
      } else if (data.includes("9;4;0")) {
        // Idle
        if (state === "busy") {
          state = "done"
          // Check focus before showing checkmark
          getActiveTabName().then((active) => {
            if (state !== "done") return
            if (isOurTabActive(active)) {
              state = "idle"
              showPlain()
            } else {
              showDone()
            }
          }).catch(() => { showDone() })
        }
      } else if (data.includes("9;4;2")) {
        // Error
        if (state === "busy") { state = "idle"; showPlain() }
      }

      // Detect OSC 0 title from ChatInterface.tsx (via stderr)
      const titleMatch = data.match(/\x1b\]0;([^\x07]*)\x07/)
      if (titleMatch && titleMatch[1]) {
        const title = titleMatch[1]
        if (title && title !== "GitLab Duo CLI" && title !== "") {
          currentTitle = title
          // Don't override spinner if already running
          if (state === "idle") {
            writeTitle(currentTitle)
          }
        }
      }
    }

    return origWriteSync(fd, ...args)
  }

  // --- Also intercept stderr.write to catch the title ---
  const origStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write
  process.stderr.write = function patchedWrite(
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    const str = typeof chunk === "string" ? chunk : chunk?.toString?.() || ""
    const titleMatch = str.match(/\x1b\]0;([^\x07]*)\x07/)
    if (titleMatch && titleMatch[1]) {
      const title = titleMatch[1]
      if (title && title !== "GitLab Duo CLI" && title !== "") {
        currentTitle = title
        if (state === "idle") {
          writeTitle(currentTitle)
        }
      }
    }
    return origStderrWrite(chunk, encodingOrCb as any, cb as any)
  }

  // Cleanup on exit
  process.on("exit", () => {
    stopSpinner()
    stopFocusPoll()
    if (ttyFd !== null) {
      try { closeSync(ttyFd) } catch { /* ignore */ }
    }
  })
}
