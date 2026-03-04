import { ItemView, WorkspaceLeaf, Scope } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { ShellManager } from "./shell-manager";
import { CLI_BACKENDS } from "./backends";
import type VaultTerminalPlugin from "./main";

export const VIEW_TYPE = "vault-terminal";

export class TerminalView extends ItemView {
  term: Terminal | null = null;
  fitAddon: FitAddon | null = null;
  proc: ChildProcess | null = null;
  hasOutput = false;

  plugin: VaultTerminalPlugin;

  private shell: ShellManager;
  private resizeObserver: ResizeObserver | null = null;
  private termHost: HTMLElement | null = null;
  private escapeScope: Scope | null = null;
  private fitTimeout: ReturnType<typeof setTimeout> | null = null;
  private themeObserver: MutationObserver | null = null;
  private imagePasteHandler: ((e: ClipboardEvent) => void) | null = null;
  private fileDragOverHandler: ((e: DragEvent) => void) | null = null;
  private fileDropHandler: ((e: DragEvent) => void) | null = null;
  private workingDir: string | null = null;
  private yoloMode = false;
  private continueSession = false;

  constructor(leaf: WorkspaceLeaf, plugin: VaultTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.shell = new ShellManager(
      () => this.getBackend(),
      this.plugin.pluginData,
      () => this.plugin.getVaultPath(),
      () => this.plugin.ideServer?.port ?? null,
    );
  }

  getBackend() {
    const key = this.plugin.pluginData.cliBackend || "claude";
    return CLI_BACKENDS[key] || CLI_BACKENDS.claude;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Claude";
  }

  getIcon(): string {
    return "bot";
  }

  // Obsidian calls setState() with custom state from setViewState()
  async setState(state: Record<string, unknown>, result: unknown): Promise<void> {
    if (state?.workingDir) {
      this.workingDir = state.workingDir as string;
    }
    if (state?.yoloMode) {
      this.yoloMode = state.yoloMode as boolean;
    }
    if (state?.continueSession) {
      this.continueSession = state.continueSession as boolean;
    }
    // If shell already started, restart with new settings
    if (this.proc && (state?.workingDir || state?.yoloMode || state?.continueSession)) {
      this.startShell(this.workingDir, this.yoloMode, this.continueSession);
    }
  }

  getState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    if (this.workingDir) state.workingDir = this.workingDir;
    if (this.yoloMode) state.yoloMode = this.yoloMode;
    // Don't persist continueSession — it's a one-time action
    return state;
  }

  async onOpen(): Promise<void> {
    this.injectCSS();
    this.buildUI();
    this.initTerminal();
    // Delay shell start slightly to allow setState() to be called first
    setTimeout(() => {
      if (!this.proc) {
        this.startShell(this.workingDir, this.yoloMode, this.continueSession);
      }
    }, 10);
    this.setupEscapeHandler();
  }

  setupEscapeHandler(): void {
    // Use Obsidian's Scope API to intercept Escape at keymap level
    // This works above DOM events and can override Obsidian's built-in handlers
    this.escapeScope = new Scope(this.app.scope);
    this.escapeScope.register([], "Escape", () => {
      // Only intercept when terminal has focus
      if (this.containerEl.contains(document.activeElement)) {
        if (this.proc && !this.proc.killed) {
          this.proc.stdin?.write("\x1b");
        }
        return false; // Block further handling by Obsidian
      }
      return true; // Let Obsidian handle it normally
    });
    this.app.keymap.pushScope(this.escapeScope);
  }

  async onClose(): Promise<void> {
    this.dispose();
  }

  injectCSS(): void {
    if (document.getElementById("xterm-css")) return;
    const style = document.createElement("style");
    style.id = "xterm-css";
    style.textContent = `/**
 * Copyright (c) 2014 The xterm.js authors. All rights reserved.
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * https://github.com/chjj/term.js
 * @license MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 *   The original design remains. The terminal itself
 *   has been extended to include xterm CSI codes, among
 *   other features.
 */

/**
 *  Default styles for xterm.js
 */

.xterm {
    cursor: text;
    position: relative;
    user-select: none;
    -ms-user-select: none;
    -webkit-user-select: none;
}

.xterm.focus,
.xterm:focus {
    outline: none;
}

.xterm .xterm-helpers {
    position: absolute;
    top: 0;
    /**
     * The z-index of the helpers must be higher than the canvases in order for
     * IMEs to appear on top.
     */
    z-index: 5;
}

.xterm .xterm-helper-textarea {
    padding: 0;
    border: 0;
    margin: 0;
    /* Move textarea out of the screen to the far left, so that the cursor is not visible */
    position: absolute;
    opacity: 0;
    left: -9999em;
    top: 0;
    width: 0;
    height: 0;
    z-index: -5;
    /** Prevent wrapping so the IME appears against the textarea at the correct position */
    white-space: nowrap;
    overflow: hidden;
    resize: none;
}

.xterm .composition-view {
    /* TODO: Composition position got messed up somewhere */
    background: #000;
    color: #FFF;
    display: none;
    position: absolute;
    white-space: nowrap;
    z-index: 1;
}

.xterm .composition-view.active {
    display: block;
}

.xterm .xterm-viewport {
    /* On OS X this is required in order for the scroll bar to appear fully opaque */
    background-color: #000;
    overflow-y: scroll;
    cursor: default;
    position: absolute;
    right: 0;
    left: 0;
    top: 0;
    bottom: 0;
}

.xterm .xterm-screen {
    position: relative;
}

.xterm .xterm-screen canvas {
    position: absolute;
    left: 0;
    top: 0;
}

.xterm .xterm-scroll-area {
    visibility: hidden;
}

.xterm-char-measure-element {
    display: inline-block;
    visibility: hidden;
    position: absolute;
    top: 0;
    left: -9999em;
    line-height: normal;
}

.xterm.enable-mouse-events {
    /* When mouse events are enabled (eg. tmux), revert to the standard pointer cursor */
    cursor: default;
}

.xterm.xterm-cursor-pointer,
.xterm .xterm-cursor-pointer {
    cursor: pointer;
}

.xterm.column-select.focus {
    /* Column selection mode */
    cursor: crosshair;
}

.xterm .xterm-accessibility:not(.debug),
.xterm .xterm-message {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 10;
    color: transparent;
    pointer-events: none;
}

.xterm .xterm-accessibility-tree:not(.debug) *::selection {
  color: transparent;
}

.xterm .xterm-accessibility-tree {
  user-select: text;
  white-space: pre;
}

.xterm .live-region {
    position: absolute;
    left: -9999px;
    width: 1px;
    height: 1px;
    overflow: hidden;
}

.xterm-dim {
    /* Dim should not apply to background, so the opacity of the foreground color is applied
     * explicitly in the generated class and reset to 1 here */
    opacity: 1 !important;
}

.xterm-underline-1 { text-decoration: underline; }
.xterm-underline-2 { text-decoration: double underline; }
.xterm-underline-3 { text-decoration: wavy underline; }
.xterm-underline-4 { text-decoration: dotted underline; }
.xterm-underline-5 { text-decoration: dashed underline; }

.xterm-overline {
    text-decoration: overline;
}

.xterm-overline.xterm-underline-1 { text-decoration: overline underline; }
.xterm-overline.xterm-underline-2 { text-decoration: overline double underline; }
.xterm-overline.xterm-underline-3 { text-decoration: overline wavy underline; }
.xterm-overline.xterm-underline-4 { text-decoration: overline dotted underline; }
.xterm-overline.xterm-underline-5 { text-decoration: overline dashed underline; }

.xterm-strikethrough {
    text-decoration: line-through;
}

.xterm-screen .xterm-decoration-container .xterm-decoration {
	z-index: 6;
	position: absolute;
}

.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer {
	z-index: 7;
}

.xterm-decoration-overview-ruler {
    z-index: 8;
    position: absolute;
    top: 0;
    right: 0;
    pointer-events: none;
}

.xterm-decoration-top {
    z-index: 2;
    position: relative;
}
`;
    document.head.appendChild(style);
  }

  private loadingEl: HTMLElement | null = null;
  private outputBytes = 0;

  buildUI(): void {
    const container = this.containerEl;
    container.empty();
    container.addClass("vault-terminal");
    this.termHost = container.createDiv({ cls: "vault-terminal-host" });
    this.loadingEl = container.createDiv({ cls: "vault-terminal-loading" });
    this.loadingEl.innerHTML = `<div class="vault-terminal-spinner"></div><div>Starting Claude...</div>`;
  }

  hideLoading(): void {
    if (this.loadingEl) {
      this.loadingEl.classList.add("vault-terminal-loading-fade");
      setTimeout(() => {
        this.loadingEl?.remove();
        this.loadingEl = null;
      }, 300);
    }
  }

  getThemeColors(): { background: string; foreground: string; cursor: string; selectionBackground?: string } {
    const styles = getComputedStyle(document.body);
    const bg = styles.getPropertyValue("--background-secondary").trim() || "#1e1e1e";
    const fg = styles.getPropertyValue("--text-normal").trim() || "#d4d4d4";
    const cursor = styles.getPropertyValue("--text-accent").trim() || "#ffffff";
    // Light mode needs a more visible selection color
    const isLightMode = document.body.classList.contains("theme-light");
    const selectionBackground = isLightMode ? "rgba(0, 100, 200, 0.3)" : undefined;
    return { background: bg, foreground: fg, cursor, selectionBackground };
  }

  updateTheme(): void {
    if (!this.term) return;
    const newTheme = this.getThemeColors();
    const cur = this.term.options.theme;
    // Only update if theme actually changed
    if (cur?.background !== newTheme.background || cur?.foreground !== newTheme.foreground) {
      this.term.options.theme = newTheme;
    }
  }

  async saveImageToTemp(blob: Blob): Promise<string> {
    const os = require("os");
    const ext = blob.type.split("/")[1] || "png";
    const filename = `claude_paste_${Date.now()}.${ext}`;
    const tempPath = path.join(os.tmpdir(), filename);
    const buffer = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);
    return tempPath;
  }

  initTerminal(): void {
    if (!this.termHost) return;
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', 'Microsoft YaHei', 'SimHei', 'PingFang SC', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', monospace",
      theme: this.getThemeColors(),
      scrollback: 10000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.termHost);
    this.term.parser?.registerCsiHandler({ final: "I" }, () => true);
    this.term.parser?.registerCsiHandler({ final: "O" }, () => true);

    // Handle image paste - use capture phase to intercept before xterm's textarea
    this.imagePasteHandler = async (e: ClipboardEvent) => {
      // Only handle if terminal has focus
      if (!this.containerEl.contains(document.activeElement)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const blob = item.getAsFile();
          if (blob) {
            try {
              const imagePath = await this.saveImageToTemp(blob);
              // Insert the path into the terminal input (quoted for paths with spaces)
              if (this.proc && !this.proc.killed) {
                this.proc.stdin?.write(`"${imagePath}" `);
              }
            } catch (err: unknown) {
              this.term?.writeln(`\r\n[Image paste error: ${(err as Error).message}]`);
            }
          }
          return;
        }
      }
    };
    document.addEventListener("paste", this.imagePasteHandler as EventListener, true);

    // Handle file drag-and-drop
    this.fileDragOverHandler = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    this.fileDropHandler = async (e: DragEvent) => {
      e.preventDefault();
      if (!this.proc || this.proc.killed) return;
      // Check for Obsidian internal file drag (obsidian:// URL)
      const textData = e.dataTransfer?.getData("text/plain");
      if (textData && textData.startsWith("obsidian://")) {
        try {
          const url = new URL(textData);
          const filePath = url.searchParams.get("file");
          if (filePath) {
            const decodedPath = decodeURIComponent(filePath);
            const absolutePath = (this.app.vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(decodedPath);
            this.proc.stdin?.write(`"${absolutePath}" `);
            return;
          }
        } catch (err) {
          console.error("Failed to parse obsidian URL:", err);
        }
      }
      // Handle external file drops
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const { webUtils } = require("electron");
        for (const file of files) {
          const filePath = webUtils.getPathForFile(file);
          if (filePath) {
            this.proc.stdin?.write(`"${filePath}" `);
          }
        }
      }
    };
    this.termHost.addEventListener("dragover", this.fileDragOverHandler as EventListener);
    this.termHost.addEventListener("drop", this.fileDropHandler as EventListener);

    this.term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      // Shift+Enter: send Alt+Enter for multi-line input
      // Must block both keydown and keypress events to prevent xterm from sending normal Enter
      if (ev.key === "Enter" && ev.shiftKey) {
        if (ev.type === "keydown") {
          if (this.proc && !this.proc.killed) {
            this.proc.stdin?.write("\x1b\r");
          }
        }
        return false; // Block both keydown and keypress
      }
      if (ev.type === "keydown") {
        // Cmd+Arrow: readline shortcuts for line navigation
        if (ev.metaKey) {
          if (ev.key === "ArrowRight") {
            this.proc?.stdin?.write("\x05"); // Ctrl+E = end of line
            return false;
          }
          if (ev.key === "ArrowLeft") {
            this.proc?.stdin?.write("\x01"); // Ctrl+A = start of line
            return false;
          }
        }
      }
      return true;
    });

    this.term.onData((data: string) => {
      if (this.proc && !this.proc.killed) {
        // Filter out focus in/out sequences before sending to shell
        const filtered = data.replace(/\x1b\[I/g, "").replace(/\x1b\[O/g, "");
        if (filtered) {
          this.proc.stdin?.write(filtered);
        }
      }
    });

    this.ensureFitWithRetry();
    this.resizeObserver = new ResizeObserver(() => this.debouncedFit());
    this.resizeObserver.observe(this.termHost);

    // Watch for theme changes
    this.themeObserver = new MutationObserver(() => this.updateTheme());
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    // Watch for Obsidian layout changes (sidebar resize, etc.)
    this.registerEvent((this.app.workspace as any).onLayoutChange(() => this.debouncedFit()));
  }

  fit(): void {
    if (!this.term || !this.fitAddon) return;
    try {
      // Check if terminal is at bottom before resize
      const wasAtBottom = this.term.buffer.active.baseY === this.term.buffer.active.viewportY;
      this.fitAddon.fit();
      // Only auto-scroll if we were already at bottom
      if (wasAtBottom) {
        this.term.scrollToBottom();
      }
    } catch (e) {}
  }

  debouncedFit(): void {
    if (this.fitTimeout) clearTimeout(this.fitTimeout);
    this.fitTimeout = setTimeout(() => {
      this.fit();
      this.fitTimeout = null;
    }, 100);
  }

  async waitForHostReady(): Promise<boolean> {
    if (!this.fitAddon) return false;
    for (let i = 0; i < 10; i++) {
      const dim = this.fitAddon.proposeDimensions();
      if (dim && dim.cols > 0 && dim.rows > 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async ensureFitWithRetry(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const dim = this.fitAddon?.proposeDimensions();
      if (dim && dim.rows > 0) {
        this.fit();
        // If shell already running, send resize
        if (this.proc && !this.proc.killed) {
          this.proc.stdin?.write(`\x1b]RESIZE;${dim.cols};${dim.rows}\x07`);
        }
        return;
      }
    }
  }

  startShell(workingDir: string | null = null, yoloMode = false, continueSession = false): void {
    this.shell.stop();
    this.hasOutput = false;
    this.outputBytes = 0;

    // Persist last working directory for resume
    const defaultDir = this.plugin.pluginData.defaultWorkingDir;
    const vaultPath = this.plugin.getVaultPath();
    const resolvedDefault = defaultDir ? path.resolve(vaultPath, defaultDir) : vaultPath;
    const cwd = workingDir || resolvedDefault;
    this.plugin.pluginData.lastCwd = cwd;
    this.plugin.saveData(this.plugin.pluginData);

    const isWindows = process.platform === "win32";

    this.shell.start(
      {
        workingDir,
        yoloMode,
        continueSession,
        cols: this.term?.cols,
        rows: this.term?.rows,
      },
      {
        onStdout: (text: string) => {
          this.outputBytes += text.length;
          // Hide loading after enough output to suggest the CLI has fully started
          if (this.loadingEl && this.outputBytes > 500) this.hideLoading();
          this.hasOutput = true;
          if (this.term) {
            const buffer = this.term.buffer.active;
            const atBottom = buffer.baseY === buffer.viewportY;
            this.term.write(text);
            if (atBottom) this.term.scrollToBottom();
          }
        },
        onStderr: (text: string) => {
          this.term?.write(text);
        },
        onExit: (code: number | null, signal: string | null) => {
          if (isWindows && code === 9009) {
            this.term?.writeln("\r\n[Python not found]");
            this.term?.writeln("Install Python from https://python.org");
            this.term?.writeln("Or run: winget install Python.Python.3");
          } else {
            this.term?.writeln(`\r\n[Process exited: ${code ?? signal}]`);
          }
          this.proc = null;
        },
      }
    );
    this.proc = this.shell.proc;

    // Send resize when terminal dimensions change
    this.term?.onResize(({ cols: c, rows: r }) => {
      if (this.proc && !this.proc.killed) {
        this.proc.stdin?.write(`\x1b]RESIZE;${c};${r}\x07`);
      }
    });

    // Safety: Verify dimensions after shell starts and send resize if needed
    setTimeout(() => {
      if (this.proc && !this.proc.killed && this.fitAddon) {
        const currentDims = this.fitAddon.proposeDimensions();
        if (currentDims && currentDims.rows > 0) {
          this.proc.stdin?.write(`\x1b]RESIZE;${currentDims.cols};${currentDims.rows}\x07`);
        }
      }
    }, 500);

    this.term?.focus();

    // Windows still needs auto-launch since we can't use exec there
    if (isWindows) {
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          const backend = this.getBackend();
          let winCmd = backend.binary;
          if (backend.binary === "claude") winCmd += " --ide";
          if (yoloMode && backend.yoloFlag) winCmd += " " + backend.yoloFlag;
          this.proc.stdin?.write(winCmd + "\r");
        }
      }, 1000);
    }
  }

  stopShell(): void {
    this.shell.stop();
    this.proc = null;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    if (this.fitTimeout) {
      clearTimeout(this.fitTimeout);
      this.fitTimeout = null;
    }
    if (this.escapeScope) {
      this.app.keymap.popScope(this.escapeScope);
      this.escapeScope = null;
    }
    if (this.imagePasteHandler) {
      document.removeEventListener("paste", this.imagePasteHandler as EventListener, true);
      this.imagePasteHandler = null;
    }
    if (this.fileDragOverHandler && this.termHost) {
      this.termHost.removeEventListener("dragover", this.fileDragOverHandler as EventListener);
      this.fileDragOverHandler = null;
    }
    if (this.fileDropHandler && this.termHost) {
      this.termHost.removeEventListener("drop", this.fileDropHandler as EventListener);
      this.fileDropHandler = null;
    }
    this.stopShell();
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
  }
}
