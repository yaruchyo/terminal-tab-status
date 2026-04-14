#!/usr/bin/env node

/**
 * CLI for terminal-tab-status.
 *
 * Installs terminal tab status indicators (spinner/checkmark) for AI CLI tools.
 *
 * Usage:
 *   npx terminal-tab-status                    # Install for both OpenCode and Duo CLI
 *   npx terminal-tab-status opencode           # Install for OpenCode only
 *   npx terminal-tab-status duo                # Install for Duo CLI only
 *   npx terminal-tab-status opencode duo       # Install for both (explicit)
 *   npx terminal-tab-status uninstall          # Uninstall both
 *   npx terminal-tab-status uninstall opencode # Uninstall OpenCode only
 *   npx terminal-tab-status uninstall duo      # Uninstall Duo CLI only
 *
 * Options:
 *   --local   Install to current project (.opencode/plugins/) instead of global
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(__dirname, "..")
const PLUGIN_FILENAME = "terminal-tab-status.ts"
const BINARY_NAME = "active-terminal-tab"
const SWIFT_SOURCE = "active-terminal-tab.swift"

const args = process.argv.slice(2)
const isLocal = args.includes("--local")
const filteredArgs = args.filter((a) => a !== "--local")

// Parse command
const isUninstall = filteredArgs[0] === "uninstall"
const isHelp = !filteredArgs.length ? false : ["help", "--help", "-h"].includes(filteredArgs[0])

// Parse targets
let targets
if (isHelp) {
  targets = []
} else if (isUninstall) {
  const uninstallArgs = filteredArgs.slice(1).filter((a) => a === "opencode" || a === "duo")
  targets = uninstallArgs.length > 0 ? uninstallArgs : ["opencode", "duo"]
} else {
  const installArgs = filteredArgs.filter((a) => a === "opencode" || a === "duo")
  targets = installArgs.length > 0 ? installArgs : ["opencode", "duo"]
}

const installOpencode = targets.includes("opencode")
const installDuo = targets.includes("duo")

if (isHelp) {
  console.log(`
  terminal-tab-status — AI session status in your terminal tabs

  Usage:
    npx terminal-tab-status                     Install for OpenCode + Duo CLI (default)
    npx terminal-tab-status opencode            Install for OpenCode only
    npx terminal-tab-status duo                 Install for Duo CLI only
    npx terminal-tab-status opencode duo        Install for both (explicit)

    npx terminal-tab-status uninstall           Uninstall both
    npx terminal-tab-status uninstall opencode  Uninstall OpenCode only
    npx terminal-tab-status uninstall duo       Uninstall Duo CLI only

  Options:
    --local   Install to current project instead of global (~/.config/opencode/)
  `)
  process.exit(0)
}

function getTargetDir(local) {
  if (local) {
    return join(process.cwd(), ".opencode")
  }
  return join(homedir(), ".config", "opencode")
}

function compileBinary(targetDir) {
  const binDir = join(targetDir, "bin")
  mkdirSync(binDir, { recursive: true })

  const swiftSrc = join(PACKAGE_DIR, "bin", SWIFT_SOURCE)
  const binaryDst = join(binDir, BINARY_NAME)

  if (process.platform !== "darwin") {
    console.log("  Skipping Swift compilation (not macOS). Focus detection disabled.")
    return null
  }

  if (!existsSync(swiftSrc)) {
    console.log("  Swift source not found. Focus detection disabled.")
    return null
  }

  // Copy Swift source to target
  copyFileSync(swiftSrc, join(binDir, SWIFT_SOURCE))

  try {
    execFileSync("swiftc", [
      "-O", "-o", binaryDst, swiftSrc,
      "-framework", "Cocoa", "-framework", "ApplicationServices"
    ], { stdio: "pipe" })
    return binaryDst
  } catch {
    console.log("  Swift compilation failed. Focus detection disabled.")
    console.log("  You can compile manually:")
    console.log(`  swiftc -O -o "${binaryDst}" "${swiftSrc}" -framework Cocoa -framework ApplicationServices`)
    return null
  }
}

// --- Install ---

if (!isUninstall) {
  const targetDir = getTargetDir(isLocal)
  const scope = isLocal ? "project" : "global"
  let binPath = null

  // Compile Swift binary (shared by both opencode and duo)
  if (installOpencode || installDuo) {
    console.log("Compiling Swift binary...")
    binPath = compileBinary(targetDir)
  }

  // OpenCode plugin
  if (installOpencode) {
    const pluginsDir = join(targetDir, "plugins")
    mkdirSync(pluginsDir, { recursive: true })

    const srcFile = join(PACKAGE_DIR, "src", "standalone-plugin.ts")
    const dstFile = join(pluginsDir, PLUGIN_FILENAME)
    copyFileSync(srcFile, dstFile)
    console.log(`OpenCode plugin: ${dstFile}`)
  }

  // Duo CLI hook
  if (installDuo) {
    const hookSrc = join(PACKAGE_DIR, "bin", "duo-hook.cjs")
    const hookDst = join(targetDir, "bin", "duo-hook.cjs")
    if (existsSync(hookSrc)) {
      const binDir = join(targetDir, "bin")
      mkdirSync(binDir, { recursive: true })
      copyFileSync(hookSrc, hookDst)
      console.log(`Duo CLI hook:    ${hookDst}`)

      // Add NODE_OPTIONS to ~/.zshrc (global only)
      if (!isLocal) {
        const zshrcPath = join(homedir(), ".zshrc")
        const hookLine = `export NODE_OPTIONS="\${NODE_OPTIONS} --require ${hookDst}"`
        const marker = "# terminal-tab-status: duo-hook"
        const zshrc = existsSync(zshrcPath) ? readFileSync(zshrcPath, "utf-8") : ""
        if (!zshrc.includes(marker)) {
          const entry = `\n${marker}\n${hookLine}\n`
          writeFileSync(zshrcPath, zshrc + entry)
          console.log(`Added duo hook to ~/.zshrc`)
        } else {
          console.log(`Duo hook already in ~/.zshrc`)
        }
      }
    }
  }

  // Summary
  console.log(`\n=== Installed (${scope}) ===`)
  const parts = []
  if (installOpencode) parts.push("OpenCode")
  if (installDuo) parts.push("Duo CLI")
  console.log(`Targets: ${parts.join(" + ")}`)
  if (binPath) console.log(`Focus binary: ${binPath}`)
  console.log("")
  if (installOpencode) console.log("OpenCode: restart to activate.")
  if (installDuo && !isLocal) console.log("Duo CLI:  run 'source ~/.zshrc' or restart terminal.")

// --- Uninstall ---

} else {
  const targetDir = getTargetDir(isLocal)
  let removed = false

  if (installOpencode) {
    const pluginFile = join(targetDir, "plugins", PLUGIN_FILENAME)
    if (existsSync(pluginFile)) {
      unlinkSync(pluginFile)
      console.log(`Removed: ${pluginFile}`)
      removed = true
    }
  }

  if (installDuo) {
    const hookFile = join(targetDir, "bin", "duo-hook.cjs")
    if (existsSync(hookFile)) {
      unlinkSync(hookFile)
      console.log(`Removed: ${hookFile}`)
      removed = true
    }

    // Remove duo hook from ~/.zshrc
    if (!isLocal) {
      const zshrcPath = join(homedir(), ".zshrc")
      const marker = "# terminal-tab-status: duo-hook"
      if (existsSync(zshrcPath)) {
        const zshrc = readFileSync(zshrcPath, "utf-8")
        if (zshrc.includes(marker)) {
          const lines = zshrc.split("\n")
          const filtered = lines.filter((line, i) => {
            if (line.includes(marker)) return false
            if (i > 0 && lines[i - 1].includes(marker)) return false
            return true
          })
          writeFileSync(zshrcPath, filtered.join("\n").replace(/\n{3,}/g, "\n\n"))
          console.log(`Removed duo hook from ~/.zshrc`)
          removed = true
        }
      }
    }
  }

  // Remove shared binary (only if both are being uninstalled or neither target uses it)
  if (installOpencode && installDuo) {
    const binaryFile = join(targetDir, "bin", BINARY_NAME)
    const swiftFile = join(targetDir, "bin", SWIFT_SOURCE)
    for (const f of [binaryFile, swiftFile]) {
      if (existsSync(f)) {
        unlinkSync(f)
        console.log(`Removed: ${f}`)
        removed = true
      }
    }
  }

  if (!removed) {
    console.log("Nothing to remove.")
  } else {
    console.log("Restart terminals to deactivate.")
  }
}
