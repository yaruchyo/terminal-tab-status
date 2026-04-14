# terminal-tab-status

OpenCode plugin that syncs terminal tab names with session titles.

See at a glance which AI session is running, finished, or idle — across all your terminal tabs.

## What it does

| State | Tab title | When |
|---|---|---|
| **Idle** | `Session Title` | Default state |
| **Running** | `⠋ Session Title` | AI is processing (animated spinner) |
| **Done** | `✓ Session Title` | AI finished responding |

The checkmark automatically disappears when you switch to that terminal tab (macOS — uses the Accessibility API to detect tab focus across all major terminals).

## Install

One command — installs globally across all your projects:

```bash
npx terminal-tab-status install
```

That's it. Restart OpenCode.

This copies the plugin file into `~/.config/opencode/plugins/` (which OpenCode auto-loads globally) and compiles the Swift binary for focus detection.

> **macOS note**: On first run, macOS will prompt you to grant Accessibility access to your terminal application. This is required for focus detection — the Swift binary ([source](bin/active-terminal-tab.swift)) reads only the active tab/window title from your terminal app. It cannot read terminal content, keystrokes, or data from other apps. The permission is granted to the terminal app, not this binary specifically. If you prefer not to grant it, deny the prompt — everything still works, the checkmark just clears on your next message instead of on tab switch.

To install for a single project only:

```bash
npx terminal-tab-status install --local
```

This copies into `.opencode/plugins/` in the current project.

To uninstall:

```bash
npx terminal-tab-status uninstall
npx terminal-tab-status uninstall --local  # for project-local
```

### Alternative: npm-based install

If you prefer the npm plugin approach (requires the package to be published on npm):

```bash
npx terminal-tab-status install --npm
```

This adds `"terminal-tab-status"` to `~/.config/opencode/opencode.json` and OpenCode auto-installs it from npm on startup.

## JetBrains IDE setup (PyCharm, IntelliJ, etc.)

JetBrains terminals require one extra setting to allow processes to set tab titles:

1. Open **Settings** (Cmd+,)
2. Go to **Advanced Settings**
3. Search for `terminal.show.application.title`
4. **Enable** the checkbox
5. Restart the terminal

Other terminals (Terminal.app, iTerm2, Ghostty, Kitty, Wezterm, VS Code) work out of the box — no extra setup needed.

## macOS focus detection setup

For the checkmark to auto-clear when you switch to a tab, the plugin needs macOS Accessibility access:

1. Open **System Settings > Privacy & Security > Accessibility**
2. Enable access for your terminal application

The Swift binary is compiled automatically during install (requires Xcode Command Line Tools). If compilation fails, everything still works — the checkmark just clears when you send the next message instead of on tab focus.

## How it works

1. **Title sync**: Listens for `session.created`, `session.updated` events and writes OSC escape sequences to `/dev/tty` to set the terminal tab title.

2. **Spinner**: On `session.status` (busy), cycles through Braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 100ms via `/dev/tty`.

3. **Checkmark**: On `session.idle`, shows `✓` prefix if the tab is not focused. If the tab is focused, shows plain title.

4. **Focus detection** (macOS): A compiled Swift binary queries the macOS Accessibility API to detect the active terminal tab. It auto-detects which terminal is frontmost and uses the appropriate strategy:

   | Terminal | Detection method |
   |---|---|
   | JetBrains IDEs | Reads `AXDescription` from the Terminal tool window group |
   | Terminal.app | Reads `AXTitle` from the focused window (format: `user — title — process — WxH`) |
   | iTerm2 | Reads `AXTitle` from the focused window |
   | VS Code | Reads `AXTitle` from the focused window |
   | Ghostty | Reads `AXTitle` from the focused window |
   | Kitty | Reads `AXTitle` from the focused window |
   | Wezterm | Reads `AXTitle` from the focused window |
   | Other | Falls back to frontmost app's window title |

   The binary is ~68ms per invocation, polls every 500ms, and only runs while the checkmark is visible.

### Why `/dev/tty`?

OpenCode runs a TUI that owns `process.stdout`. Writing escape sequences to stdout gets swallowed. Writing to `/dev/tty` bypasses the TUI and reaches the terminal emulator directly.

### Why a Swift binary?

JetBrains terminals don't support ANSI focus reporting (`\x1b[?1004h`). The only cross-terminal way to detect which tab is active is to query the macOS Accessibility API, which requires native code.

## Compatibility

| Terminal | Title sync | Spinner | Focus detection |
|---|---|---|---|
| PyCharm / IntelliJ (macOS) | Yes* | Yes | Yes |
| Terminal.app (macOS) | Yes | Yes | Yes |
| iTerm2 (macOS) | Yes | Yes | Yes |
| Ghostty (macOS) | Yes | Yes | Yes |
| Kitty (macOS) | Yes | Yes | Yes |
| Wezterm (macOS) | Yes | Yes | Yes |
| VS Code terminal (macOS) | Yes | Yes | Yes |
| Linux terminals | Yes | Yes | No** |
| CI environments | No | No | No |

\* Requires `terminal.show.application.title` Advanced Setting enabled.
\*\* Accessibility API is macOS-only. PRs welcome for Linux focus detection (e.g. via `xdotool`).

## Manual Swift compilation

If compilation fails during install, compile manually:

```bash
swiftc -O \
  -o ~/.config/opencode/bin/active-terminal-tab \
  ~/.config/opencode/bin/active-terminal-tab.swift \
  -framework Cocoa -framework ApplicationServices
```

You can also test the binary directly:

```bash
# Auto-detect frontmost terminal
~/.config/opencode/bin/active-terminal-tab

# Force a specific terminal type
~/.config/opencode/bin/active-terminal-tab jetbrains
~/.config/opencode/bin/active-terminal-tab apple_terminal
~/.config/opencode/bin/active-terminal-tab iterm2
```

## What gets installed

### Global install (`npx terminal-tab-status install`)

```
~/.config/opencode/
├── plugins/
│   └── terminal-tab-status.ts    # Plugin (auto-loaded by OpenCode)
└── bin/
    ├── active-terminal-tab           # Compiled Swift binary
    └── active-terminal-tab.swift     # Swift source
```

### Project install (`npx terminal-tab-status install --local`)

```
.opencode/
├── plugins/
│   └── terminal-tab-status.ts
└── bin/
    ├── active-terminal-tab
    └── active-terminal-tab.swift
```

## Development

```bash
# Clone
git clone https://gitlab.com/yaruchyk.o/terminal-tab-status.git
cd terminal-tab-status

# Install deps
npm install

# Build
npm run build

# Test install locally
node scripts/cli.js install

# Test uninstall
node scripts/cli.js uninstall
```

## License

MIT
