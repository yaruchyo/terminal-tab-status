// Returns the name of the currently active terminal tab in JetBrains IDEs.
// Uses macOS Accessibility API (requires accessibility permissions).
// Prints the active tab name to stdout, or empty string if not found.
//
// Compile: swiftc -O -o active-terminal-tab active-terminal-tab.swift -framework Cocoa -framework ApplicationServices
import Cocoa
import ApplicationServices

let apps = NSWorkspace.shared.runningApplications.filter {
    let name = $0.localizedName?.lowercased() ?? ""
    return name.contains("pycharm") || name.contains("intellij") ||
           name.contains("webstorm") || name.contains("goland") ||
           name.contains("rider") || name.contains("clion") ||
           name.contains("rubymine") || name.contains("phpstorm") ||
           name.contains("datagrip") || name.contains("dataspell") ||
           name.contains("aqua") || name.contains("fleet")
}
guard let ide = apps.first else { exit(0) }

let appRef = AXUIElementCreateApplication(ide.processIdentifier)
var focusedWindow: AnyObject?
AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute as CFString, &focusedWindow)
guard let window = focusedWindow as! AXUIElement? else { exit(0) }

func findTerminalToolWindow(_ element: AXUIElement, depth: Int = 0) -> String? {
    if depth > 5 { return nil }
    var desc: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &desc)
    let d = desc as? String ?? ""
    if d.hasSuffix("Tool Window") {
        var children: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
        if let kids = children as? [AXUIElement] {
            for kid in kids {
                var role: AnyObject?
                var kidDesc: AnyObject?
                AXUIElementCopyAttributeValue(kid, kAXRoleAttribute as CFString, &role)
                AXUIElementCopyAttributeValue(kid, kAXDescriptionAttribute as CFString, &kidDesc)
                if (role as? String) == "AXStaticText" && (kidDesc as? String) == "Terminal" {
                    let suffix = " Tool Window"
                    return String(d.dropLast(suffix.count))
                }
            }
        }
    }
    var children: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
    if let kids = children as? [AXUIElement] {
        for kid in kids {
            if let found = findTerminalToolWindow(kid, depth: depth + 1) { return found }
        }
    }
    return nil
}

if let activeTab = findTerminalToolWindow(window) {
    print(activeTab)
}
