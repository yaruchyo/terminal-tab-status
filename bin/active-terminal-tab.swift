// Returns the name/title of the currently active terminal tab.
// Supports: JetBrains IDEs, Terminal.app, iTerm2, VS Code, Ghostty, Kitty, Wezterm.
// Uses macOS Accessibility API (requires accessibility permissions).
//
// Usage: active-terminal-tab [terminal-type]
//   terminal-type: jetbrains, apple_terminal, iterm2, vscode, ghostty, kitty, wezterm
//   If omitted, auto-detects based on frontmost app.
//
// Prints the active tab name to stdout, or empty string if not found.
//
// Compile: swiftc -O -o active-terminal-tab active-terminal-tab.swift -framework Cocoa -framework ApplicationServices

import Cocoa
import ApplicationServices

// --- Helpers ---

func getApp(matching names: [String]) -> NSRunningApplication? {
    return NSWorkspace.shared.runningApplications.first { app in
        let name = app.localizedName?.lowercased() ?? ""
        return names.contains(where: { name.contains($0) })
    }
}

func getFocusedWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let appRef = AXUIElementCreateApplication(app.processIdentifier)
    var window: AnyObject?
    AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute as CFString, &window)
    return window as! AXUIElement?
}

func getWindowTitle(_ window: AXUIElement) -> String? {
    var title: AnyObject?
    AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title)
    return title as? String
}

func getAttr(_ element: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    AXUIElementCopyAttributeValue(element, attr as CFString, &val)
    return val as? String ?? ""
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    var children: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
    return children as? [AXUIElement] ?? []
}

// --- JetBrains IDEs ---
// The terminal tool window group's AXDescription = "<active tab name> Tool Window"

func jetbrainsActiveTab() -> String? {
    let names = ["pycharm", "intellij", "webstorm", "goland", "rider", "clion",
                 "rubymine", "phpstorm", "datagrip", "dataspell", "aqua", "fleet"]
    guard let app = getApp(matching: names),
          let window = getFocusedWindow(app) else { return nil }

    func find(_ element: AXUIElement, depth: Int = 0) -> String? {
        if depth > 5 { return nil }
        let desc = getAttr(element, kAXDescriptionAttribute as String)
        if desc.hasSuffix("Tool Window") {
            for kid in getChildren(element) {
                if getAttr(kid, kAXRoleAttribute as String) == "AXStaticText" &&
                   getAttr(kid, kAXDescriptionAttribute as String) == "Terminal" {
                    return String(desc.dropLast(" Tool Window".count))
                }
            }
        }
        for kid in getChildren(element) {
            if let found = find(kid, depth: depth + 1) { return found }
        }
        return nil
    }

    return find(window)
}

// --- Generic window-title terminals ---
// Terminal.app, iTerm2, Ghostty, Kitty, Wezterm, VS Code all expose
// the active tab/session title in the focused window's AXTitle attribute
// (set via OSC 0 or OSC 2 escape sequences).

func windowTitleTab(appNames: [String], bundleContains: String? = nil, bundleEquals: String? = nil) -> String? {
    guard let app = NSWorkspace.shared.runningApplications.first(where: { running in
        let name = running.localizedName?.lowercased() ?? ""
        let bundle = running.bundleIdentifier?.lowercased() ?? ""
        if let eq = bundleEquals, bundle == eq { return true }
        if let bc = bundleContains, bundle.contains(bc) { return true }
        return appNames.contains(where: { name.contains($0) })
    }) else { return nil }

    guard let window = getFocusedWindow(app),
          let title = getWindowTitle(window) else { return nil }
    return title
}

// --- Auto-detect ---

func autoDetect() -> String? {
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    let name = front.localizedName?.lowercased() ?? ""
    let bundle = front.bundleIdentifier?.lowercased() ?? ""

    // JetBrains IDEs — special AX tree structure
    let jb = ["pycharm", "intellij", "webstorm", "goland", "rider", "clion",
              "rubymine", "phpstorm", "datagrip", "dataspell", "aqua", "fleet"]
    if jb.contains(where: { name.contains($0) }) || bundle.contains("jetbrains") {
        return jetbrainsActiveTab()
    }

    // All other terminals: window title reflects the active tab
    if bundle == "com.apple.terminal"     { return windowTitleTab(appNames: ["terminal"], bundleEquals: "com.apple.terminal") }
    if bundle.contains("iterm2")          { return windowTitleTab(appNames: ["iterm"], bundleContains: "iterm2") }
    if bundle.contains("vscode")          { return windowTitleTab(appNames: ["code", "visual studio code"], bundleContains: "vscode") }
    if bundle.contains("ghostty")         { return windowTitleTab(appNames: ["ghostty"], bundleContains: "ghostty") }
    if name.contains("kitty")             { return windowTitleTab(appNames: ["kitty"]) }
    if name.contains("wezterm")           { return windowTitleTab(appNames: ["wezterm"]) }

    // Unknown terminal — try reading the frontmost app's window title as fallback
    guard let window = getFocusedWindow(front),
          let title = getWindowTitle(window) else { return nil }
    return title
}

// --- Main ---

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1].lowercased() : "auto"

let result: String?

switch mode {
case "jetbrains":       result = jetbrainsActiveTab()
case "apple_terminal":  result = windowTitleTab(appNames: ["terminal"], bundleEquals: "com.apple.terminal")
case "iterm2":          result = windowTitleTab(appNames: ["iterm"], bundleContains: "iterm2")
case "vscode":          result = windowTitleTab(appNames: ["code"], bundleContains: "vscode")
case "ghostty":         result = windowTitleTab(appNames: ["ghostty"], bundleContains: "ghostty")
case "kitty":           result = windowTitleTab(appNames: ["kitty"])
case "wezterm":         result = windowTitleTab(appNames: ["wezterm"])
default:                result = autoDetect()
}

if let tab = result {
    print(tab)
}
