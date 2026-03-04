# Claude Sidebar IDE

Run Claude Code (and other AI coding CLIs) directly in your Obsidian sidebar — with full IDE integration so Claude automatically knows what you're working on.

**Forked from [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar) by Derek Larson.**

## What's Different From the Original

The original plugin embeds a terminal in your Obsidian sidebar and lets you run Claude Code. This fork adds **IDE integration** — the same protocol that VS Code, Neovim, and JetBrains use to give Claude automatic awareness of your editor state.

### IDE Integration

Claude Code supports an IDE integration protocol where editors run a local WebSocket server and expose tools for querying editor state. This fork implements that full protocol for Obsidian:

- **Automatic context** — Claude knows which file you have open and what text is selected, no copy/pasting paths or manual "Send to Claude" commands needed
- **WebSocket MCP server** — runs on localhost, writes a lock file to `~/.claude/ide/`, and sets environment variables so Claude discovers Obsidian automatically
- **Full tool support** — implements `getCurrentSelection`, `getOpenEditors`, `getWorkspaceFolders`, `openFile`, `openDiff` (with a modal UI for accepting/rejecting changes), and more
- **Selection tracking** — pushes `selection_changed` notifications to Claude as you navigate, debounced at 150ms
- **Diff review modal** — when Claude wants to edit a file, you get a side-by-side diff modal to accept or reject the changes

### Multi-Backend Support

Run any of these AI coding CLIs from the same sidebar:

- **Claude Code** (with full IDE integration)
- **Codex CLI**
- **Gemini CLI**
- **OpenCode**
- **Aider**

Switch backends in settings. IDE integration is active when using Claude Code; other backends run as standard terminal sessions.

### TypeScript Rewrite

The original was a single monolithic `main.js`. This fork restructures into typed, modular TypeScript:

```
src/
  main.ts          — plugin lifecycle, commands, ribbon menu
  terminal-view.ts — xterm.js terminal rendering and PTY management
  ide-server.ts    — WebSocket MCP server for IDE integration
  ide-tools.ts     — tool handlers (getCurrentSelection, openDiff, etc.)
  ws-framing.ts    — raw WebSocket frame parser (no dependencies)
  diff-modal.ts    — side-by-side diff review UI
  backends.ts      — CLI backend definitions
  settings.ts      — settings tab UI
  types.ts         — shared type definitions
```

Built with esbuild. PTY helper scripts are base64-embedded at compile time.

### CI/CD

Automated releases via GitHub Actions. Push a version tag (`v1.0.0`) and the workflow builds, typechecks, and publishes a GitHub Release with the three files Obsidian needs: `main.js`, `manifest.json`, `styles.css`.

### Other Improvements

- Right-click "Send selection to Claude" context menu
- "Run Claude from this folder" command
- Resume last conversation support
- Chinese IME and CJK input support
- Multi-tab terminal support
- YOLO mode (skip permissions) toggle
- Linux PTY permission fix
- Scroll behavior fixes

## Installation

### Via BRAT (Recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. In BRAT settings, click "Add Beta plugin"
3. Enter: `MatthewHallCom/obsidian-claude-sidebar-ide`
4. Enable "Claude Sidebar IDE" in Settings > Community Plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/MatthewHallCom/obsidian-claude-sidebar-ide/releases/latest)
2. Create `.obsidian/plugins/claude-sidebar-ide/` in your vault
3. Place the three files there
4. Enable "Claude Sidebar IDE" in Settings > Community Plugins

## Requirements

- Desktop only (macOS, Linux, Windows)
- Python 3
- At least one AI CLI installed ([Claude Code](https://claude.com/claude-code), Codex, Gemini CLI, OpenCode, or Aider)

### Windows

Windows requires [pywinpty](https://github.com/andfoy/pywinpty):

```bash
pip install pywinpty
```

Performance may be slower than macOS/Linux due to ConPTY overhead.

## Usage

- Click the bot icon in the left ribbon to open Claude
- Right-click the bot icon for YOLO mode, folder targeting, or resuming a conversation
- Right-click any folder for "Open Claude here" or "Open Claude here (YOLO)"
- Use Command Palette (`Cmd+P`) for all commands:
  - **Open Claude Code** / **New Claude Tab** / **Close Claude Tab**
  - **Toggle Focus: Editor ↔ Claude**
  - **Run Claude from this folder**
  - **Resume last conversation** (`--continue`)
  - **Send File Path to Claude** / **Send Selection to Claude**
- Press `Shift+Enter` for multi-line input

## How It Works

The plugin creates an [xterm.js](https://xtermjs.org/) terminal in your Obsidian sidebar and spawns the AI CLI as a child process via a Python PTY bridge (`pty` on Unix, `pywinpty` on Windows).

When using Claude Code, the plugin also starts a **WebSocket MCP server** on localhost that implements the [Claude Code IDE integration protocol](https://github.com/anthropics/claude-code). This is the same protocol used by the official VS Code extension and community integrations like [claudecode.nvim](https://github.com/cloudcodedev/claudecode.nvim). The server:

1. Binds to a random port on `127.0.0.1`
2. Writes a lock file to `~/.claude/ide/[port].lock` with connection metadata
3. Sets `CLAUDE_CODE_SSE_PORT` and `ENABLE_IDE_INTEGRATION=true` in the shell environment
4. Claude Code CLI discovers the server via the lock file, connects over WebSocket, and authenticates
5. The plugin pushes `selection_changed` notifications as you navigate files
6. Claude calls tools like `getCurrentSelection`, `getOpenEditors`, `openFile`, and `openDiff` to interact with Obsidian

This gives Claude the same ambient awareness of your editor state that it has in VS Code — which file is open, what's selected, what other files are in your workspace — without any manual context passing.

## Development

```bash
bun install
bun run dev       # watch mode
bun run build     # production build
bun run check     # typecheck + build
```

## License

MIT — see [LICENSE](LICENSE).

Original work copyright (c) 2025 [Derek Larson](https://github.com/derek-larson14). Fork copyright (c) 2026 [Matthew Hall](https://github.com/MatthewHallCom).
