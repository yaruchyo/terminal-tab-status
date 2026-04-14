#!/usr/bin/env node

/**
 * Postinstall script for terminal-tab-status.
 *
 * On macOS: compiles the Swift binary for terminal focus detection.
 * On other platforms: skips gracefully (focus detection is macOS-only).
 */

import { execFileSync } from "child_process"
import { existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const binDir = join(__dirname, "..", "bin")
const swiftSource = join(binDir, "active-terminal-tab.swift")
const binaryPath = join(binDir, "active-terminal-tab")

if (process.platform !== "darwin") {
  console.log(
    "[terminal-tab-status] Skipping Swift compilation (not macOS). Focus detection disabled.",
  )
  process.exit(0)
}

if (existsSync(binaryPath)) {
  console.log("[terminal-tab-status] Binary already compiled.")
  process.exit(0)
}

if (!existsSync(swiftSource)) {
  console.warn(
    "[terminal-tab-status] Swift source not found. Focus detection disabled.",
  )
  process.exit(0)
}

try {
  console.log("[terminal-tab-status] Compiling Swift binary for focus detection...")
  execFileSync("swiftc", [
    "-O", "-o", binaryPath, swiftSource,
    "-framework", "Cocoa", "-framework", "ApplicationServices"
  ], { stdio: "inherit" })
  console.log("[terminal-tab-status] Done.")
} catch (err) {
  console.warn(
    "[terminal-tab-status] Swift compilation failed. Focus detection disabled.",
  )
  console.warn(
    "[terminal-tab-status] You can compile manually: swiftc -O -o bin/active-terminal-tab bin/active-terminal-tab.swift -framework Cocoa -framework ApplicationServices",
  )
  // Don't fail the install
  process.exit(0)
}
