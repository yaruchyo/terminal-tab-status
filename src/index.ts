import type { Plugin } from "@opencode-ai/plugin"
import { writeFileSync, openSync, closeSync, existsSync } from "fs"
import { execFile } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

/**
 * OpenCode plugin that syncs terminal tab names with session titles.
 *
 * Features:
 * - Sets tab title to session name on create/rename
 * - Animated Braille spinner while the AI is processing
 * - Checkmark when the AI finishes responding
 * - Checkmark auto-removed when the terminal tab gains focus
 *   (macOS: detected via Accessibility API polling)
 *
 * Writes OSC escape sequences directly to /dev/tty to bypass the TUI.
 *
 * JetBrains IDEs require: Advanced Settings -> terminal.show.application.title = true
 *
 * Event property shapes (from OpenCode source):
 *   session.created / session.updated: { info: { id, title, ... } }
 *   session.status:  { sessionID, status: { type: "idle"|"busy"|"retry" } }
 *   session.idle:    { sessionID }
 *   session.error:   { sessionID?, error }
 */
export const TerminalTitlePlugin: Plugin = async ({ directory, client }) => {
  const project = directory.split("/").pop() || "opencode"

  // Resolve the path to the compiled Swift binary for focus detection
  const activeTabBin = resolveActiveTabBin(directory)

  // State
  let currentTitle = project
  let spinnerInterval: ReturnType<typeof setInterval> | null = null
  let focusPollInterval: ReturnType<typeof setInterval> | null = null
  let state: "idle" | "busy" | "done" = "idle"

  // Braille spinner frames
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let frameIndex = 0

  /**
   * Strip control characters from text to prevent terminal escape sequence injection.
   * A malicious session title could inject arbitrary OSC/CSI sequences via \x1b or
   * terminate the OSC sequence early via \x07 (BEL).
   */
  function sanitize(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x1f\x7f]/g, "")
  }

  function writeToTerminal(text: string) {
    let fd: number | null = null
    try {
      fd = openSync("/dev/tty", "w")
      const safe = sanitize(text)
      // OSC 2 = window title (PyCharm), OSC 0 = icon + window title (others)
      writeFileSync(fd, `\x1b]2;${safe}\x07\x1b]0;${safe}\x07`)
    } catch {
      // /dev/tty may not be available (e.g. in CI)
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore close errors
        }
      }
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

  function unrefInterval(interval: ReturnType<typeof setInterval>) {
    if (interval && typeof interval === "object" && "unref" in interval) {
      ;(interval as NodeJS.Timeout).unref()
    }
  }

  function startSpinner() {
    stopSpinner()
    frameIndex = 0
    writeToTerminal(`${frames[0]} ${currentTitle}`)
    spinnerInterval = setInterval(() => {
      frameIndex = (frameIndex + 1) % frames.length
      writeToTerminal(`${frames[frameIndex]} ${currentTitle}`)
    }, 100)
    unrefInterval(spinnerInterval)
  }

  function showDone() {
    stopSpinner()
    writeToTerminal(`\u2713 ${currentTitle}`)
    startFocusPoll()
  }

  function showPlain() {
    stopSpinner()
    stopFocusPoll()
    writeToTerminal(currentTitle)
  }

  // Query the macOS Accessibility API to check if our tab is active
  function getActiveTabName(): Promise<string> {
    return new Promise((resolve) => {
      if (!activeTabBin) {
        resolve("")
        return
      }
      execFile(activeTabBin, { timeout: 500 }, (err, stdout) => {
        if (err) {
          resolve("")
          return
        }
        resolve(stdout.trim())
      })
    })
  }

  // Check if our tab matches the active tab name.
  // The AX tree may truncate long names with "…" (e.g. "✓ New Docker c…x architrecture").
  // We need to match both the plain title and the "✓ " prefixed version, accounting for truncation.
  function isOurTabActive(activeTabName: string): boolean {
    if (!activeTabName) return false

    // Strip the checkmark/spinner prefix from the AX name for comparison
    // Spinner frames are single Braille chars (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) followed by space
    const stripped = activeTabName.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓] /, "")

    // Exact match (with or without prefix)
    if (stripped === currentTitle || activeTabName === currentTitle) return true

    // The AX name starts with our title (no truncation)
    if (stripped.startsWith(currentTitle) || activeTabName.startsWith(currentTitle)) return true

    // Handle truncation: AX shows "Some long ti…end of title"
    // Extract the part before "…" and check if our title starts with it
    const truncIdx = stripped.indexOf("\u2026")
    if (truncIdx > 0) {
      const prefix = stripped.substring(0, truncIdx)
      if (currentTitle.startsWith(prefix)) return true
    }

    // Same check on the raw activeTabName (in case it has no spinner/checkmark prefix)
    const rawTruncIdx = activeTabName.indexOf("\u2026")
    if (rawTruncIdx > 0) {
      const prefix = activeTabName.substring(0, rawTruncIdx)
      if (currentTitle.startsWith(prefix)) return true
    }

    return false
  }

  // Poll for focus changes when in "done" state
  function startFocusPoll() {
    stopFocusPoll()
    if (!activeTabBin) return // No binary = no polling (graceful degradation)

    focusPollInterval = setInterval(async () => {
      if (state !== "done") {
        stopFocusPoll()
        return
      }
      try {
        const activeTab = await getActiveTabName()
        if (isOurTabActive(activeTab)) {
          state = "idle"
          showPlain()
        }
      } catch {
        // Ignore errors
      }
    }, 500)

    unrefInterval(focusPollInterval)
  }

  // Track whether we've fetched the initial session title
  let initialTitleFetched = false

  // Set initial title on startup
  writeToTerminal(currentTitle)

  return {
    event: async ({ event }) => {
      // Once server is ready, fetch the current session title
      if (event.type === "server.connected" && !initialTitleFetched) {
        initialTitleFetched = true
        try {
          const sessions = await client.session.list()
          if (sessions?.data && sessions.data.length > 0) {
            const latest = (sessions.data as Array<{ title?: string }>)[0]
            if (latest.title) {
              currentTitle = latest.title
              showPlain()
            }
          }
        } catch {
          // Fall back to project name
        }
      }

      // Track session title changes
      if (
        event.type === "session.updated" ||
        event.type === "session.created"
      ) {
        const props = event.properties as { info?: { title?: string } }
        const title = props?.info?.title
        if (title) {
          currentTitle = title
          if (state === "busy") {
            // Spinner will pick up new title on next tick
          } else if (state === "done") {
            showDone()
          } else {
            showPlain()
          }
        }
      }

      // Session status changed
      if (event.type === "session.status") {
        const props = event.properties as {
          status?: { type?: string }
        }
        const statusType = props?.status?.type
        if (statusType && statusType !== "idle") {
          state = "busy"
          startSpinner()
        }
      }

      // AI finished -> show checkmark or plain depending on focus
      if (event.type === "session.idle") {
        if (state === "busy") {
          try {
            const activeTab = await getActiveTabName()
            if (isOurTabActive(activeTab)) {
              state = "idle"
              showPlain()
            } else {
              state = "done"
              showDone()
            }
          } catch {
            state = "done"
            showDone()
          }
        }
      }

      // On error, stop spinner and show plain title
      if (event.type === "session.error") {
        state = "idle"
        showPlain()
      }
    },
  }
}

/**
 * Resolve the path to the active-terminal-tab binary.
 * Looks in multiple locations (in order):
 * 1. Sibling bin/ directory (file-based install: ~/.config/opencode/plugins/ -> ~/.config/opencode/bin/)
 * 2. Package's own bin/ directory (npm install)
 * 3. Project's .opencode/bin/ directory (project-local install)
 * 4. Global ~/.config/opencode/bin/ directory
 */
function resolveActiveTabBin(directory: string): string | null {
  if (process.platform !== "darwin") return null

  const binary = "active-terminal-tab"

  // 1. Sibling bin/ relative to the plugin file (file-based install)
  //    e.g. ~/.config/opencode/plugins/opencode-terminal-title.ts -> ~/.config/opencode/bin/
  try {
    const pluginDir = dirname(fileURLToPath(import.meta.url))
    const siblingBin = join(pluginDir, "..", "bin", binary)
    if (existsSync(siblingBin)) return siblingBin
  } catch {
    // import.meta.url may not be a file URL
  }

  // 2. Package's own bin/ directory (npm-based install)
  try {
    const packageBin = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "bin",
      binary,
    )
    if (existsSync(packageBin)) return packageBin
  } catch {
    // import.meta.url may not be a file URL
  }

  // 3. Project's .opencode/bin/ directory
  const projectBin = join(directory, ".opencode", "bin", binary)
  if (existsSync(projectBin)) return projectBin

  // 4. Global config bin/ directory
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (home) {
    const globalBin = join(home, ".config", "opencode", "bin", binary)
    if (existsSync(globalBin)) return globalBin
  }

  return null
}
