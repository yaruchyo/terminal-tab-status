# terminal-tab-status

See at a glance which AI session is running, finished, or idle -- right in your terminal tab.

Works with [OpenCode](https://opencode.ai) and [GitLab Duo CLI](https://docs.gitlab.com/ee/user/gitlab_duo/gitlab_duo_cli/).

| State | Tab title | When |
|-------|-----------|------|
| Idle | `Session Title` | Default |
| Running | `⠋ Session Title` | AI is processing (animated Braille spinner) |
| Done | `✓ Session Title` | AI finished (auto-clears when you focus the tab) |

## Quick start

```bash
# Both OpenCode and Duo CLI
npx terminal-tab-status

# OpenCode only
npx terminal-tab-status opencode

# Duo CLI only
npx terminal-tab-status duo
```

Restart OpenCode and/or your terminal to activate.

## How each tool is configured

### OpenCode

The installer copies a TypeScript plugin file into the OpenCode plugins directory:

```
~/.config/opencode/plugins/terminal-tab-status.ts
```

OpenCode auto-loads all `.ts` files from this directory on startup. The plugin listens for session lifecycle events (`session.created`, `session.updated`, `session.status`, `session.idle`, `session.error`) and writes [OSC escape sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) directly to `/dev/tty` to set the terminal tab title. Writing to `/dev/tty` bypasses the TUI that owns `process.stdout`.

**No config files to edit.** Just install and restart OpenCode.

### GitLab Duo CLI

The installer does two things:

1. Copies a CommonJS hook module to `~/.config/opencode/bin/duo-hook.cjs`
2. Appends a `NODE_OPTIONS` line to `~/.zshrc`:
   ```bash
   export NODE_OPTIONS="${NODE_OPTIONS} --require ~/.config/opencode/bin/duo-hook.cjs"
   ```

The hook is loaded into every Node.js process via `--require`, but **immediately bails out** unless it detects a `@gitlab/duo-cli` process (checked via `process.argv[1]`). When active, it:

- Intercepts `fs.writeSync` to detect Duo's `TerminalProgressService` OSC 9;4 progress sequences (busy / idle / error)
- Intercepts `process.stderr.write` to capture the session title set via OSC 0
- Writes enhanced titles (spinner/checkmark) to its own `/dev/tty` file descriptor

**No modifications to Duo CLI source.** No monkey-patching of Duo internals. The hook reads the same escape sequences Duo already writes, then overlays its own.

### Shared: focus detection (macOS)

Both tools share a compiled Swift binary that queries the macOS Accessibility API to detect which terminal tab is currently focused. When the AI finishes:

- If the tab is focused: title resets immediately (you're already looking at it)
- If the tab is not focused: shows `✓` prefix, polls every 500ms, clears when you switch to it

The binary auto-detects the frontmost terminal and uses the appropriate strategy:

| Terminal | Detection method |
|----------|-----------------|
| JetBrains IDEs (PyCharm, IntelliJ, etc.) | `AXDescription` from Terminal tool window group |
| Terminal.app | `AXTitle` from focused window |
| iTerm2 | `AXTitle` from focused window |
| VS Code | `AXTitle` from focused window |
| Ghostty | `AXTitle` from focused window |
| Kitty | `AXTitle` from focused window |
| Wezterm | `AXTitle` from focused window |
| Other | Falls back to frontmost app's window title |

## Install options

```bash
# Global (default) -- installs to ~/.config/opencode/
npx terminal-tab-status
npx terminal-tab-status opencode
npx terminal-tab-status duo
npx terminal-tab-status opencode duo

# Project-local -- installs to .opencode/ in current directory
npx terminal-tab-status --local
npx terminal-tab-status opencode --local
```

### Uninstall

```bash
npx terminal-tab-status uninstall              # Both
npx terminal-tab-status uninstall opencode     # OpenCode only
npx terminal-tab-status uninstall duo          # Duo only
npx terminal-tab-status uninstall --local      # Project-local
```

## What gets installed

### Global install

```
~/.config/opencode/
├── plugins/
│   └── terminal-tab-status.ts        # OpenCode plugin (auto-loaded)
└── bin/
    ├── active-terminal-tab            # Compiled Swift binary
    ├── active-terminal-tab.swift      # Swift source
    └── duo-hook.cjs                   # Duo CLI hook
```

Plus a `NODE_OPTIONS` line in `~/.zshrc` (Duo only).

### Project-local install

```
.opencode/
├── plugins/
│   └── terminal-tab-status.ts
└── bin/
    ├── active-terminal-tab
    ├── active-terminal-tab.swift
    └── duo-hook.cjs
```

## Terminal setup

### JetBrains IDEs (PyCharm, IntelliJ, etc.)

JetBrains terminals require one setting to allow processes to set tab titles:

1. **Settings** > **Advanced Settings**
2. Search `terminal.show.application.title`
3. Enable the checkbox
4. Restart the terminal

All other terminals work out of the box.

### macOS Accessibility (optional)

For the checkmark to auto-clear on tab focus, grant Accessibility access:

1. **System Settings** > **Privacy & Security** > **Accessibility**
2. Enable your terminal application

If you skip this, the checkmark clears on your next message instead of on tab switch. Everything else works normally.

## Compatibility

| Terminal | Title sync | Spinner | Focus detection |
|----------|-----------|---------|-----------------|
| PyCharm / IntelliJ (macOS) | Yes | Yes | Yes |
| Terminal.app | Yes | Yes | Yes |
| iTerm2 | Yes | Yes | Yes |
| Ghostty | Yes | Yes | Yes |
| Kitty | Yes | Yes | Yes |
| Wezterm | Yes | Yes | Yes |
| VS Code terminal | Yes | Yes | Yes |
| Linux terminals | Yes | Yes | No\* |
| CI environments | No | No | No |

\* Accessibility API is macOS-only. See [Contributing](#contributing) if you'd like to add Linux support.

## Troubleshooting

### Swift compilation fails

The binary is compiled automatically during install. If it fails, compile manually:

```bash
swiftc -O \
  -o ~/.config/opencode/bin/active-terminal-tab \
  ~/.config/opencode/bin/active-terminal-tab.swift \
  -framework Cocoa -framework ApplicationServices
```

Requires Xcode Command Line Tools (`xcode-select --install`).

### Duo hook causes issues with other Node.js tools

The hook only activates for `@gitlab/duo-cli` processes (strict `process.argv[1]` check). If you still experience issues, temporarily disable it:

```bash
NODE_OPTIONS="" npm install   # or any other command
```

To remove permanently: `npx terminal-tab-status uninstall duo`

### Testing the Swift binary

```bash
# Auto-detect frontmost terminal
~/.config/opencode/bin/active-terminal-tab

# Force a specific terminal
~/.config/opencode/bin/active-terminal-tab jetbrains
~/.config/opencode/bin/active-terminal-tab apple_terminal
~/.config/opencode/bin/active-terminal-tab iterm2
```

## Contributing

Contributions are welcome. The canonical repository is on GitLab -- the GitHub repo is a read-only mirror.

**Source of truth:** https://gitlab.com/yaruchyk.o/terminal-tab-status

1. Fork on [GitLab](https://gitlab.com/yaruchyk.o/terminal-tab-status)
2. Create a feature branch
3. Submit a merge request

The [GitHub mirror](https://github.com/yaruchyo/terminal-tab-status) is updated automatically via GitLab push mirroring. Do not open pull requests on GitHub.

### Development

```bash
git clone https://gitlab.com/yaruchyk.o/terminal-tab-status.git
cd terminal-tab-status
npm install
npm run build

# Test install
node scripts/cli.js              # both
node scripts/cli.js opencode     # opencode only
node scripts/cli.js duo          # duo only

# Test uninstall
node scripts/cli.js uninstall
```

### Areas where help is needed

- **Linux focus detection** -- `xdotool` or similar for detecting the active terminal tab on X11/Wayland
- **Bash/fish shell support** -- the Duo hook currently only writes to `~/.zshrc`
- **Additional AI CLI tools** -- the architecture supports any tool that writes progress/title escape sequences

## Security

- The Swift binary reads **only** the active tab/window title via the Accessibility API. It cannot read terminal content, keystrokes, or data from other apps.
- The Duo hook strips all C0 and C1 control characters from titles before writing to the terminal, preventing escape sequence injection.
- The Duo hook uses the original `fs.writeSync` reference for its own writes, avoiding infinite recursion with its own interceptor.
- `NODE_OPTIONS --require` loads the hook into every Node.js process, but the hook exits immediately for non-Duo processes (strict `process.argv[1]` check).

## License

MIT
