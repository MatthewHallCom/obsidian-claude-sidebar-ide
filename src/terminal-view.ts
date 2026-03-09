import { ItemView, WorkspaceLeaf, Scope, Platform, Notice } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IShellManager } from "./shell-interface";
import { CLI_BACKENDS } from "./backends";
import type VaultTerminalPlugin from "./main";
import VoiceView from "./voice/voice-view";
import VoiceController from "./voice/voice-controller";
import { LocalClaudeBridge, SpritesClaudeBridge } from "./voice/claude-bridge";

export const VIEW_TYPE = "vault-terminal";

export class TerminalView extends ItemView {
  term: Terminal | null = null;
  fitAddon: FitAddon | null = null;
  hasOutput = false;

  plugin: VaultTerminalPlugin;

  private shell: IShellManager;
  private resizeObserver: ResizeObserver | null = null;
  private termHost: HTMLElement | null = null;
  private escapeScope: Scope | null = null;
  private fitTimeout: ReturnType<typeof setTimeout> | null = null;
  private themeObserver: MutationObserver | null = null;
  private copyHandler: ((e: ClipboardEvent) => void) | null = null;
  private imagePasteHandler: ((e: ClipboardEvent) => void) | null = null;
  private fileDragOverHandler: ((e: DragEvent) => void) | null = null;
  private fileDropHandler: ((e: DragEvent) => void) | null = null;
  private workingDir: string | null = null;
  private yoloMode = false;
  private continueSession = false;
  private voiceView: VoiceView | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VaultTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.shell = plugin.createShellManager(
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
    if (this.shell.isRunning && (state?.workingDir || state?.yoloMode || state?.continueSession)) {
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
      if (!this.shell.isRunning) {
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
        if (this.shell.isRunning) {
          this.shell.write("\x1b");
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
  private reconnectEl: HTMLElement | null = null;
  private outputBytes = 0;

  toggleVoiceMode(): void {
    if (this.voiceView) {
      this.voiceView.hide();
      this.voiceView = null;
      return;
    }
    const apiKey = this.plugin.pluginData.deepgramApiKey;
    if (!apiKey) {
      new Notice("Set your Deepgram API key in settings to use voice mode.");
      return;
    }
    let bridge;
    if (this.plugin.pluginData.runtimeMode === 'sprites' && this.plugin.spriteManager) {
      bridge = new SpritesClaudeBridge(this.plugin.spriteManager);
    } else {
      bridge = new LocalClaudeBridge();
    }
    const controller = new VoiceController({
      apiKey,
      ttsVoice: this.plugin.pluginData.ttsVoice ?? undefined,
      vadSensitivity: this.plugin.pluginData.vadSensitivity ?? undefined,
      bridge,
    });
    this.voiceView = new VoiceView(this.containerEl, controller);
    this.voiceView.show();
  }

  buildUI(): void {
    const container = this.containerEl;
    container.empty();
    container.addClass("vault-terminal");
    this.termHost = container.createDiv({ cls: "vault-terminal-host" });
    this.loadingEl = container.createDiv({ cls: "vault-terminal-loading" });
    this.loadingEl.innerHTML = `<div class="vault-terminal-spinner"></div><div>Starting Claude...</div>`;

    const micBtn = container.createEl("button", { cls: "voice-mic-btn" });
    micBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1.5 4v6a1.5 1.5 0 0 0 3 0V5a1.5 1.5 0 0 0-3 0zM7 11a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h-2v-3.08A7 7 0 0 1 5 11h2z"/></svg>`;
    micBtn.addEventListener("click", () => this.toggleVoiceMode());
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

  showReconnecting(): void {
    if (!this.reconnectEl) {
      this.reconnectEl = this.containerEl.createDiv({ cls: "vault-terminal-reconnecting" });
      this.reconnectEl.innerHTML =
        `<div class="vault-terminal-spinner"></div>` +
        `<div>Reconnecting...</div>`;
    }
  }

  hideReconnecting(): void {
    if (this.reconnectEl) {
      this.reconnectEl.classList.add("vault-terminal-loading-fade");
      setTimeout(() => {
        this.reconnectEl?.remove();
        this.reconnectEl = null;
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
    // Node.js only — caller must guard for desktop
    const os = require("os") as { tmpdir(): string };
    const path = require("path") as { join(...parts: string[]): string };
    const fs = require("fs") as { writeFileSync(p: string, d: unknown): void };
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

    // Intercept all copy events (including mobile long-press) to clean soft-wrapped text
    this.copyHandler = (e: ClipboardEvent) => {
      // Try xterm's selection first (works on desktop)
      if (this.term?.hasSelection()) {
        const cleaned = this.getCleanSelection();
        if (cleaned !== null) {
          e.preventDefault();
          e.clipboardData?.setData("text/plain", cleaned);
          this.term.clearSelection();
          return;
        }
      }
      // Fallback: clean native OS selection (mobile long-press copy)
      const sel = window.getSelection();
      if (sel && sel.toString() && this.containerEl.contains(sel.anchorNode)) {
        const raw = sel.toString();
        const cleaned = this.cleanNativeSelection(raw);
        if (cleaned !== raw) {
          e.preventDefault();
          e.clipboardData?.setData("text/plain", cleaned);
        }
      }
    };
    document.addEventListener("copy", this.copyHandler as EventListener, true);

    // Handle image paste - use capture phase to intercept before xterm's textarea
    this.imagePasteHandler = async (e: ClipboardEvent) => {
      // Only handle if terminal has focus
      if (!this.containerEl.contains(document.activeElement)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/") && Platform.isDesktopApp) {
          e.preventDefault();
          e.stopPropagation();
          const blob = item.getAsFile();
          if (blob) {
            try {
              const imagePath = await this.saveImageToTemp(blob);
              // Insert the path into the terminal input (quoted for paths with spaces)
              if (this.shell.isRunning) {
                this.shell.write(`"${imagePath}" `);
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
      if (!this.shell.isRunning) return;
      // Check for Obsidian internal file drag (obsidian:// URL) — desktop only
      if (Platform.isDesktopApp) {
        const textData = e.dataTransfer?.getData("text/plain");
        if (textData && textData.startsWith("obsidian://")) {
          try {
            const url = new URL(textData);
            const filePath = url.searchParams.get("file");
            if (filePath) {
              const decodedPath = decodeURIComponent(filePath);
              const absolutePath = (this.app.vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(decodedPath);
              this.shell.write(`"${absolutePath}" `);
              return;
            }
          } catch (err) {
            console.error("Failed to parse obsidian URL:", err);
          }
        }
      }
      // Handle external file drops (desktop only — requires Electron)
      if (Platform.isDesktopApp) {
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          const { webUtils } = require("electron");
          for (const file of files) {
            const filePath = webUtils.getPathForFile(file);
            if (filePath) {
              this.shell.write(`"${filePath}" `);
            }
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
          if (this.shell.isRunning) {
            this.shell.write("\x1b\r");
          }
        }
        return false; // Block both keydown and keypress
      }
      if (ev.type === "keydown") {
        // Cmd+C / Ctrl+C with selection: copy cleaned text (strip soft-wrap artifacts)
        if ((ev.metaKey || ev.ctrlKey) && ev.key === "c" && this.term?.hasSelection()) {
          const cleaned = this.getCleanSelection();
          if (cleaned !== null) {
            navigator.clipboard.writeText(cleaned);
            this.term.clearSelection();
            return false;
          }
        }
        // Cmd+Arrow: readline shortcuts for line navigation
        if (ev.metaKey) {
          if (ev.key === "ArrowRight") {
            this.shell.write("\x05"); // Ctrl+E = end of line
            return false;
          }
          if (ev.key === "ArrowLeft") {
            this.shell.write("\x01"); // Ctrl+A = start of line
            return false;
          }
        }
      }
      return true;
    });

    this.term.onData((data: string) => {
      if (this.shell.isRunning) {
        // Filter out focus in/out sequences before sending to shell
        const filtered = data.replace(/\x1b\[I/g, "").replace(/\x1b\[O/g, "");
        if (filtered) {
          this.shell.write(filtered);
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
    this.registerEvent(this.app.workspace.on("layout-change", () => this.debouncedFit()));
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

  /** Get selected text with soft-wrap line breaks removed. */
  private getCleanSelection(): string | null {
    const sel = this.term?.getSelectionPosition();
    if (!sel || !this.term) return null;
    const buffer = this.term.buffer.active;
    const cols = this.term.cols;

    // Extract trimmed text for each selected buffer line
    const lines: string[] = [];
    for (let y = sel.start.y; y <= sel.end.y; y++) {
      const line = buffer.getLine(y);
      if (!line) { lines.push(""); continue; }

      let text: string;
      if (y === sel.start.y && y === sel.end.y) {
        text = line.translateToString(true, sel.start.x, sel.end.x);
      } else if (y === sel.start.y) {
        text = line.translateToString(true, sel.start.x);
      } else if (y === sel.end.y) {
        text = line.translateToString(true, 0, sel.end.x);
      } else {
        text = line.translateToString(true);
      }
      lines.push(text);
    }

    if (lines.length === 0) return null;
    if (lines.length === 1) return lines[0];

    // Join lines, merging continuations from soft wraps or TUI-formatted wrapping
    const result: string[] = [];
    let current = lines[0];

    for (let i = 0; i < lines.length - 1; i++) {
      const nextBufLine = buffer.getLine(sel.start.y + i + 1);
      const isSoftWrap = nextBufLine?.isWrapped === true;
      // Heuristic: if trimmed content reaches near terminal width, it's likely a wrapped line
      const isFull = lines[i].length >= cols - 2;

      if (isSoftWrap || isFull) {
        // Continuation — check if the row boundary had a space (word break vs mid-word wrap)
        const rowLine = buffer.getLine(sel.start.y + i);
        const lastCell = rowLine?.getCell(cols - 1);
        const lastChar = lastCell?.getChars() || "";
        const sep = lastChar === " " || lastChar === "" ? " " : "";
        current = current.trimEnd() + sep + lines[i + 1].trimStart();
      } else {
        result.push(current);
        current = lines[i + 1];
      }
    }
    result.push(current);

    // Strip Claude Code "⏺" bullet prefixes and leading indentation
    return result
      .map((line) => line.replace(/^⏺\s*/, "").replace(/^\s{1,2}/, ""))
      .join("\n");
  }

  /** Clean native OS selection text (mobile fallback when xterm selection isn't available). */
  private cleanNativeSelection(text: string): string {
    const cols = this.term?.cols || 80;
    const lines = text.split("\n");
    if (lines.length <= 1) return text;

    const result: string[] = [];
    let current = lines[0];

    for (let i = 0; i < lines.length - 1; i++) {
      const trimmed = lines[i].trimEnd();
      // If line fills near terminal width, it's likely a soft wrap
      if (trimmed.length >= cols - 2 || lines[i].length >= cols) {
        const endsWithSpace = lines[i].length >= cols && lines[i][cols - 1] === " ";
        const sep = endsWithSpace ? " " : "";
        current = current.trimEnd() + sep + lines[i + 1].trimStart();
      } else {
        result.push(current);
        current = lines[i + 1];
      }
    }
    result.push(current);
    return result.join("\n");
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
        if (this.shell.isRunning) {
          this.shell.resize(dim.cols, dim.rows);
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
    let resolvedDefault = vaultPath;
    if (defaultDir) {
      try {
        const path = require("path");
        resolvedDefault = path.resolve(vaultPath, defaultDir);
      } catch {
        // Mobile — path module unavailable, use simple concatenation
        resolvedDefault = vaultPath + "/" + defaultDir;
      }
    }
    const cwd = workingDir || resolvedDefault;
    this.plugin.pluginData.lastCwd = cwd;
    this.plugin.saveData(this.plugin.pluginData);

    const isWindows = typeof process !== "undefined" && process.platform === "win32";

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
          if (!this.hasOutput) {
            this.hasOutput = true;
            // First output confirms sprite is up — start remote session services
            if (this.plugin.pluginData.runtimeMode === 'sprites' && this.plugin.spriteManager?.currentSpriteName) {
              this.plugin.startRemoteSession(this.plugin.spriteManager.currentSpriteName).catch(err => {
                console.warn('Failed to start remote session:', err);
              });
            }
          }
          if (this.term) {
            const buffer = this.term.buffer.active;
            const atBottom = buffer.baseY === buffer.viewportY;
            this.term.write(text);
            if (atBottom) this.term.scrollToBottom();
          }
        },
        onStderr: (text: string) => {
          this.hideLoading();
          this.term?.write(text);
        },
        onExit: (code: number | null, signal: string | null) => {
          this.hideLoading();
          this.hideReconnecting();
          if (isWindows && code === 9009) {
            this.term?.writeln("\r\n[Python not found]");
            this.term?.writeln("Install Python from https://python.org");
            this.term?.writeln("Or run: winget install Python.Python.3");
          } else {
            this.term?.writeln(`\r\n[Process exited: ${code ?? signal}]`);
          }
          this.plugin.stopRemoteSession();
        },
        onReconnecting: () => {
          this.showReconnecting();
        },
        onReconnected: () => {
          this.hideReconnecting();
          this.term?.reset();
        },
      }
    );

    // Send resize when terminal dimensions change
    this.term?.onResize(({ cols: c, rows: r }) => {
      if (this.shell.isRunning) {
        this.shell.resize(c, r);
      }
    });

    // Safety: Verify dimensions after shell starts and send resize if needed
    setTimeout(() => {
      if (this.shell.isRunning && this.fitAddon) {
        const currentDims = this.fitAddon.proposeDimensions();
        if (currentDims && currentDims.rows > 0) {
          this.shell.resize(currentDims.cols, currentDims.rows);
        }
      }
    }, 500);

    this.term?.focus();

    // Windows still needs auto-launch since we can't use exec there
    if (isWindows) {
      setTimeout(() => {
        if (this.shell.isRunning) {
          const backend = this.getBackend();
          let winCmd = backend.binary;
          if (backend.binary === "claude") winCmd += " --ide";
          if (yoloMode && backend.yoloFlag) winCmd += " " + backend.yoloFlag;
          this.shell.write(winCmd + "\r");
        }
      }, 1000);
    }
  }

  writeToShell(data: string): void {
    this.shell.write(data);
  }

  get isShellRunning(): boolean {
    return this.shell.isRunning;
  }

  stopShell(): void {
    this.shell.stop();
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
    if (this.copyHandler) {
      document.removeEventListener("copy", this.copyHandler as EventListener, true);
      this.copyHandler = null;
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
    this.voiceView?.destroy();
    this.voiceView = null;
    this.stopShell();
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
  }
}
