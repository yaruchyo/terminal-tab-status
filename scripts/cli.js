#!/usr/bin/env node

/**
 * CLI for terminal-tab-status.
 *
 * Install strategy:
 *   - "install" (default/global): Copies plugin .ts file and Swift source into
 *     ~/.config/opencode/plugins/ and compiles the Swift binary.
 *     OpenCode auto-loads all .ts files from this directory globally.
 *
 *   - "install --local": Copies into .opencode/plugins/ in the current project.
 *
 *   - "install --npm": Adds package name to opencode.json plugin array
 *     (requires the package to be published on npm).
 *
 * Usage:
 *   npx terminal-tab-status install          # Global file-based install (recommended)
 *   npx terminal-tab-status install --local   # Project-local file-based install
 *   npx terminal-tab-status install --npm     # npm-based install via opencode.json
 *   npx terminal-tab-status uninstall         # Remove global install
 *   npx terminal-tab-status uninstall --local # Remove project-local install
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
const command = args[0]
const isLocal = args.includes("--local")
const isNpm = args.includes("--npm")

if (!command || command === "help" || command === "--help") {
  console.log(`
  terminal-tab-status - Terminal tab sync for OpenCode

  Usage:
    npx terminal-tab-status install           Copy plugin globally (~/.config/opencode/plugins/)
    npx terminal-tab-status install --local    Copy plugin to current project (.opencode/plugins/)
    npx terminal-tab-status install --npm      Add to opencode.json (requires npm publish)
    npx terminal-tab-status uninstall          Remove global plugin
    npx terminal-tab-status uninstall --local  Remove from current project
  `)
  process.exit(0)
}

function getTargetDir(local) {
  if (local) {
    return join(process.cwd(), ".opencode")
  }
  return join(homedir(), ".config", "opencode")
}

// --- npm mode (legacy: adds to opencode.json) ---

function getConfigPath(local) {
  if (local) {
    const dotOpencode = join(process.cwd(), ".opencode", "opencode.json")
    const root = join(process.cwd(), "opencode.json")
    if (existsSync(dotOpencode)) return dotOpencode
    if (existsSync(root)) return root
    return dotOpencode
  }
  return join(homedir(), ".config", "opencode", "opencode.json")
}

function readConfig(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return {}
  }
}

function writeConfig(path, config) {
  const dir = join(path, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
}

// --- file mode (default: copies plugin file + binary) ---

function generatePluginFile(binPath) {
  // Read the source .ts from the package and inject the correct binary path
  const src = readFileSync(join(PACKAGE_DIR, "src", "index.ts"), "utf-8")

  // Replace the resolveActiveTabBin function with a hardcoded path
  const modified = src.replace(
    /const activeTabBin = resolveActiveTabBin\(directory\)/,
    `const activeTabBin = ${JSON.stringify(binPath)}`
  )

  // Remove the resolveActiveTabBin function and unused imports
  return modified
    .replace(/import \{ execFile \} from "child_process"/, 'import { execFile } from "child_process"')
    .replace(/import \{ fileURLToPath \} from "url"\n/, "")
    .replace(/\/\*\*\n \* Resolve the path[\s\S]*$/, "")
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

// --- main ---

if (command === "install") {
  if (isNpm) {
    // npm mode: just edit opencode.json
    const configPath = getConfigPath(isLocal)
    const config = readConfig(configPath)
    if (!config.plugin) config.plugin = []
    if (config.plugin.includes("terminal-tab-status")) {
      console.log(`Already in ${configPath}`)
      process.exit(0)
    }
    config.plugin.push("terminal-tab-status")
    writeConfig(configPath, config)
    const scope = isLocal ? "project" : "global"
    console.log(`Added "terminal-tab-status" to ${scope} config: ${configPath}`)
    console.log(`Restart OpenCode to activate.`)
  } else {
    // File mode (default): copy plugin file + compile binary
    const targetDir = getTargetDir(isLocal)
    const pluginsDir = join(targetDir, "plugins")
    mkdirSync(pluginsDir, { recursive: true })

    console.log("Compiling Swift binary...")
    const binPath = compileBinary(targetDir)

    console.log("Installing OpenCode plugin...")
    const srcFile = join(PACKAGE_DIR, "src", "standalone-plugin.ts")
    const dstFile = join(pluginsDir, PLUGIN_FILENAME)
    copyFileSync(srcFile, dstFile)
    console.log(`  -> ${dstFile}`)

    // Install Duo CLI hook (CJS module injected via NODE_OPTIONS --require)
    const hookSrc = join(PACKAGE_DIR, "bin", "duo-hook.cjs")
    const hookDst = join(targetDir, "bin", "duo-hook.cjs")
    if (existsSync(hookSrc)) {
      const binDir = join(targetDir, "bin")
      mkdirSync(binDir, { recursive: true })
      copyFileSync(hookSrc, hookDst)
      console.log(`Duo CLI hook: ${hookDst}`)
    }

    // Check if NODE_OPTIONS is already configured for duo hook
    const zshrcPath = join(homedir(), ".zshrc")
    const hookLine = `export NODE_OPTIONS="\${NODE_OPTIONS} --require ${hookDst}"`
    const marker = "# opencode-terminal-title: duo-hook"
    let zshrcUpdated = false

    if (!isLocal && existsSync(hookDst)) {
      const zshrc = existsSync(zshrcPath) ? readFileSync(zshrcPath, "utf-8") : ""
      if (!zshrc.includes(marker)) {
        const entry = `\n${marker}\n${hookLine}\n`
        writeFileSync(zshrcPath, zshrc + entry)
        zshrcUpdated = true
      }
    }

    const scope = isLocal ? "project" : "global"
    console.log(`\n=== Installed (${scope}) ===`)
    if (binPath) console.log(`Focus binary:    ${binPath}`)
    console.log(`OpenCode plugin: ${dstFile}`)
    if (existsSync(hookDst)) console.log(`Duo CLI hook:    ${hookDst}`)
    console.log("")
    console.log("OpenCode: restart to activate.")
    if (zshrcUpdated) {
      console.log("Duo CLI:  run 'source ~/.zshrc' or restart terminal to activate.")
    } else if (existsSync(hookDst)) {
      console.log("Duo CLI:  already configured in ~/.zshrc")
    }
  }

} else if (command === "uninstall") {
  if (isNpm) {
    const configPath = getConfigPath(isLocal)
    const config = readConfig(configPath)
    if (!config.plugin || !config.plugin.includes("terminal-tab-status")) {
      console.log(`Not found in ${configPath}`)
      process.exit(0)
    }
    config.plugin = config.plugin.filter((p) => p !== "terminal-tab-status")
    if (config.plugin.length === 0) delete config.plugin
    writeConfig(configPath, config)
    const scope = isLocal ? "project" : "global"
    console.log(`Removed "terminal-tab-status" from ${scope} config: ${configPath}`)
    console.log(`Restart OpenCode to deactivate.`)
  } else {
    const targetDir = getTargetDir(isLocal)
    const pluginFile = join(targetDir, "plugins", PLUGIN_FILENAME)
    const binaryFile = join(targetDir, "bin", BINARY_NAME)
    const swiftFile = join(targetDir, "bin", SWIFT_SOURCE)
    const hookFile = join(targetDir, "bin", "duo-hook.cjs")

    let removed = false
    for (const f of [pluginFile, binaryFile, swiftFile, hookFile]) {
      if (existsSync(f)) {
        unlinkSync(f)
        console.log(`Removed: ${f}`)
        removed = true
      }
    }

    // Remove duo hook line from ~/.zshrc
    const zshrcPath = join(homedir(), ".zshrc")
    const marker = "# opencode-terminal-title: duo-hook"
    if (!isLocal && existsSync(zshrcPath)) {
      const zshrc = readFileSync(zshrcPath, "utf-8")
      if (zshrc.includes(marker)) {
        const lines = zshrc.split("\n")
        const filtered = lines.filter((line, i) => {
          if (line.includes(marker)) return false
          // Also remove the NODE_OPTIONS line that follows the marker
          if (i > 0 && lines[i - 1].includes(marker)) return false
          return true
        })
        writeFileSync(zshrcPath, filtered.join("\n").replace(/\n{3,}/g, "\n\n"))
        console.log(`Removed duo hook from ~/.zshrc`)
        removed = true
      }
    }

    if (!removed) {
      console.log("Nothing to remove.")
    } else {
      console.log("Restart terminals to deactivate.")
    }
  }

} else {
  console.error(`Unknown command: ${command}`)
  console.error(`Run "npx terminal-tab-status help" for usage.`)
  process.exit(1)
}
