import { Plugin, WorkspaceLeaf, Menu, TFolder, Notice, Platform } from "obsidian";
import { TerminalView, VIEW_TYPE } from "./terminal-view";
import { ClaudeSidebarSettingsTab } from "./settings";
import { CLI_BACKENDS } from "./backends";
import { SpriteManager } from "./sprite-manager";
import { SpritesSetupModal } from "./setup-modal";
import type { IShellManager } from "./shell-interface";
import type { PluginData, Backend } from "./types";

// Type-only imports for modules that depend on Node.js built-ins.
// Actual modules are lazy-loaded via require() to avoid crashing on mobile.
import type { IdeServer } from "./ide-server";
import type { VaultSync } from "./vault-sync";
import type { RemoteIdeClient } from "./remote-ide-client";

export default class VaultTerminalPlugin extends Plugin {
  pluginData: PluginData = {};
  ideServer: IdeServer | null = null;
  spriteManager: SpriteManager | null = null;
  vaultSync: VaultSync | null = null;
  remoteIdeClient: RemoteIdeClient | null = null;
  private lastActiveTerminalLeaf: WorkspaceLeaf | null = null;
  private lastRibbonClick = 0;

  async onload() {
    this.pluginData = await this.loadData() || {};
    this.lastActiveTerminalLeaf = null;

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

    // On mobile, migrate any sidebar leaves to full-width tabs after layout restores
    if (Platform.isMobile) {
      this.app.workspace.onLayoutReady(() => {
        const sidebarLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE)
          .filter(l => l.getRoot() !== this.app.workspace.rootSplit);
        for (const old of sidebarLeaves) {
          old.detach();
        }
      });
    }

    // Track the most recently focused Claude tab
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof TerminalView) {
          this.lastActiveTerminalLeaf = leaf;
        }
      })
    );

    const ribbonIcon = this.addRibbonIcon("bot", "New Claude Tab", () => {
      const now = Date.now();
      if (now - this.lastRibbonClick < 1500) return; // 1.5s throttle to prevent accidental double-clicks
      this.lastRibbonClick = now;
      this.createNewTab();
    });

    // Right-click context menu
    ribbonIcon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      const activeBackend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
      if (activeBackend.yoloFlag) {
        menu.addItem((item) => {
          item.setTitle("Open in YOLO mode")
            .setIcon("zap")
            .onClick(() => {
              const now = Date.now();
              if (now - this.lastRibbonClick < 1500) return;
              this.lastRibbonClick = now;
              this.createNewTab(null, true);
            });
        });
      }
      menu.addItem((item) => {
        item.setTitle("Run from active folder")
          .setIcon("folder-open")
          .onClick(() => {
            const now = Date.now();
            if (now - this.lastRibbonClick < 1500) return;
            this.lastRibbonClick = now;
            const file = this.app.workspace.getActiveFile();
            let dir: string | null = null;
            if (file) {
              const vaultPath = this.getVaultPath();
              const parentPath = file.parent ? file.parent.path : "";
              dir = parentPath ? `${vaultPath}/${parentPath}` : vaultPath;
            }
            this.createNewTab(dir);
          });
      });
      if (activeBackend.resumeFlag) {
        menu.addItem((item) => {
          item.setTitle("Resume last conversation")
            .setIcon("history")
            .onClick(() => {
              const now = Date.now();
              if (now - this.lastRibbonClick < 1500) return;
              this.lastRibbonClick = now;
              const lastCwd = this.pluginData.lastCwd || null;
              this.createNewTab(lastCwd, false, true);
            });
        });
      }
      menu.showAtMouseEvent(e);
    });

    this.addCommand({
      id: "open-claude",
      name: "Open Claude Code",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-claude-tab",
      name: "New Claude Tab",
      callback: () => this.createNewTab(),
    });

    this.addCommand({
      id: "new-claude-tab-yolo",
      name: "New Tab (YOLO mode)",
      checkCallback: (checking) => {
        const backend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
        if (!backend?.yoloFlag) return false;
        if (!checking) this.createNewTab(null, true);
        return true;
      },
    });

    this.addCommand({
      id: "close-claude-tab",
      name: "Close Claude Tab",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (view) {
          if (!checking) view.leaf.detach();
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "toggle-claude-focus",
      name: "Toggle Focus: Editor \u2194 Claude",
      callback: () => this.toggleFocus(),
    });

    this.addCommand({
      id: "send-file-to-claude",
      name: "Send File Path to Claude",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          const absolutePath = `"${this.getVaultPath()}/${file.path}" `;
          this.sendTextToTerminal(absolutePath);
        }
        return true;
      },
    });

    this.addCommand({
      id: "send-selection-to-claude",
      name: "Send Selection to Claude",
      checkCallback: (checking) => {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) return false;
        const selection = editor.getSelection();
        if (!selection) return false;
        if (!checking) {
          this.sendTextToTerminal(selection);
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-claude-from-folder",
      name: "Run Claude from this folder",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        let dir: string | null = null;
        if (file) {
          const vaultPath = this.getVaultPath();
          const parentPath = file.parent ? file.parent.path : "";
          dir = parentPath ? `${vaultPath}/${parentPath}` : vaultPath;
        }
        this.createNewTab(dir);
      },
    });

    this.addCommand({
      id: "resume-claude",
      name: "Resume last conversation",
      checkCallback: (checking) => {
        const backend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
        if (!backend?.resumeFlag) return false;
        if (!checking) {
          const lastCwd = this.pluginData.lastCwd || null;
          this.createNewTab(lastCwd, false, true);
        }
        return true;
      },
    });

    // Register folder context menu (desktop only — requires filesystem adapter)
    if (Platform.isDesktopApp) {
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          // Only show for folders, not files
          if (file instanceof TFolder) {
            menu.addItem((item) =>
              item
                .setTitle("Open Claude here")
                .setIcon("bot")
                .onClick(() => {
                  const absolutePath = (this.app.vault.adapter as any).getFullPath(file.path);
                  this.createNewTab(absolutePath);
                })
            );
            const folderBackend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
            if (folderBackend.yoloFlag) {
              menu.addItem((item) =>
                item
                  .setTitle("Open Claude here (YOLO)")
                  .setIcon("zap")
                  .onClick(() => {
                    const absolutePath = (this.app.vault.adapter as any).getFullPath(file.path);
                    this.createNewTab(absolutePath, true);
                  })
              );
            }
          }
        })
      );
    }

    // Register editor context menu (right-click on selected text)
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (selection) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to Claude")
              .setIcon("bot")
              .onClick(() => {
                this.sendTextToTerminal(selection);
              })
          );
        }
      })
    );

    // IDE integration: push selection_changed on active leaf change
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.ideServer?.pushSelection();
        this.remoteIdeClient?.pushSelection();
      })
    );

    // IDE integration: track editor content and selection changes
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.ideServer?.pushSelection();
        this.remoteIdeClient?.pushSelection();
      })
    );

    // Capture selection changes (cursor moves, text highlights) via DOM event
    const selHandler = () => {
      this.ideServer?.pushSelection();
      this.remoteIdeClient?.pushSelection();
    };
    document.addEventListener("selectionchange", selHandler);
    this.register(() => document.removeEventListener("selectionchange", selHandler));

    // Initialize runtime infrastructure based on mode
    this.updateRuntimeMode();

    this.addSettingTab(new ClaudeSidebarSettingsTab(this.app, this));
  }

  onunload() {
    // Stop remote services
    this.stopRemoteSession();
    // Stop IDE integration server
    this.stopIdeServer();
    // Kill all terminal processes before unloading to prevent orphans
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof TerminalView) {
        view.stopShell();
      }
    }
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as any;
    return adapter.basePath || "";
  }

  startIdeServer(): void {
    const { IdeServer: IdeServerImpl } = require("./ide-server");
    this.ideServer = new IdeServerImpl(this.app, () => this.getVaultPath());
    this.ideServer!.notifyCallback = (type: string, notificationType: string | null, _message: string | null) => {
      if (type === "stop") {
        new Notice("Claude finished", 4000);
      } else if (type === "notification") {
        if (notificationType === "permission_prompt") {
          new Notice("Claude needs permission", 8000);
        } else if (notificationType === "elicitation_dialog") {
          new Notice("Claude is asking a question", 8000);
        }
      }
    };
    this.ideServer!.start();
  }

  stopIdeServer(): void {
    this.ideServer?.stop();
    this.ideServer = null;
  }

  /** (Re-)initialize runtime infrastructure when mode or token changes. */
  updateRuntimeMode(): void {
    if (this.pluginData.runtimeMode === 'sprites' && this.pluginData.spritesApiToken) {
      // Sprites mode — create SpriteManager, stop local IDE server
      this.stopIdeServer();
      this.spriteManager = new SpriteManager(
        this.pluginData.spritesApiToken,
        this.app.vault.getName(),
      );
    } else {
      // Local mode — start IDE server, clear sprite manager
      this.spriteManager = null;
      try {
        this.startIdeServer();
      } catch {
        // Mobile — Node.js modules unavailable, IDE server not needed
      }
    }
  }

  // --- Remote Shell Support ---

  createShellManager(
    getBackend: () => Backend,
    pluginData: PluginData,
    getVaultPath: () => string,
    getIdePort: () => number | null,
  ): IShellManager {
    if (this.pluginData.runtimeMode === 'sprites' && this.spriteManager) {
      const { RemoteShellManager } = require("./remote-shell-manager");
      return new RemoteShellManager(getBackend, pluginData, this.spriteManager);
    }
    try {
      const { ShellManager } = require("./shell-manager");
      return new ShellManager(getBackend, pluginData, getVaultPath, getIdePort);
    } catch {
      // Mobile without Sprites — Node.js modules unavailable
      return {
        get isRunning() { return false; },
        start(_opts: unknown, callbacks: { onStdout(s: string): void; onExit(c: number, s: null): void }) {
          callbacks.onStdout('\r\nSprites mode is required on mobile.\r\nConfigure it in plugin settings.\r\n');
          callbacks.onExit(1, null);
        },
        write() {},
        resize() {},
        stop() {},
      };
    }
  }

  async startRemoteSession(spriteName: string): Promise<void> {
    if (!this.pluginData.spritesApiToken || !this.spriteManager) return;

    // Start vault sync — upload files to a dedicated subdirectory on the sprite
    const { VaultSync: VaultSyncImpl } = require("./vault-sync");
    this.vaultSync = new VaultSyncImpl(
      this.app.vault,
      this.spriteManager,
      '/home/sprite/obsidian',
    );
    try {
      await this.vaultSync!.initialUpload();
    } catch (err) {
      console.warn('VaultSync initial upload failed:', err);
    }
    // Guard against race: stopRemoteSession() may have nulled vaultSync during await
    if (!this.vaultSync) return;

    // Ensure Claude Code is installed before starting the watch WebSocket,
    // since ensureClaudeInstalled may checkpoint/restart the sprite
    await this.spriteManager.ensureClaudeInstalled();

    this.vaultSync.startWatchingVault();
    this.vaultSync.startWatchingRemote();

    // Start remote IDE client
    const { RemoteIdeClient: RemoteIdeClientImpl } = require("./remote-ide-client");
    this.remoteIdeClient = new RemoteIdeClientImpl(this.app, () => this.getVaultPath(), this.spriteManager);
    try {
      await this.remoteIdeClient!.connect();
    } catch (err) {
      console.warn('RemoteIdeClient connection failed:', err);
    }
  }

  stopRemoteSession(): void {
    this.vaultSync?.stop();
    this.vaultSync = null;
    this.remoteIdeClient?.disconnect();
    this.remoteIdeClient = null;
  }

  async destroySprite(): Promise<void> {
    this.stopRemoteSession();
    if (this.spriteManager) {
      try {
        await this.spriteManager.destroy();
        new Notice('Sprite destroyed.');
      } catch (err) {
        new Notice(`Failed to destroy Sprite: ${(err as Error).message}`);
      }
    }
  }

  private async toggleFocus(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(TerminalView);
    if (activeView) {
      // Currently in Claude, go to editor
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      if (leaves.length > 0) {
        this.app.workspace.setActiveLeaf(leaves[0], { focus: true });
      }
    } else {
      // Currently in editor, go to Claude (prefer last-active tab)
      const claudeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      if (claudeLeaves.length > 0) {
        let target = claudeLeaves[0];
        if (this.lastActiveTerminalLeaf && claudeLeaves.includes(this.lastActiveTerminalLeaf)) {
          target = this.lastActiveTerminalLeaf;
        }
        this.app.workspace.setActiveLeaf(target, { focus: true });
        const view = target.view;
        if (view instanceof TerminalView && view.term) {
          view.term.focus();
        }
      }
    }
  }

  private async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    await this.createNewTab();
  }

  async createNewTab(
    workingDir: string | null = null,
    yoloMode = false,
    continueSession = false
  ): Promise<void> {
    let leaf: WorkspaceLeaf;
    const isMobile = Platform.isMobile;
    if (isMobile) {
      // On mobile, open as a full-width tab in the main content area
      // Detach any existing Claude leaves stuck in the sidebar
      for (const old of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (old.getRoot() !== this.app.workspace.rootSplit) {
          old.detach();
        }
      }
      // Reuse existing main-area leaf, or create one explicitly in rootSplit
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)
        .filter(l => l.getRoot() === this.app.workspace.rootSplit);
      leaf = existing.length > 0
        ? existing[0]
        : this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 0);
    } else {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)
        .filter(l => l.getRoot() === this.app.workspace.rightSplit);
      leaf = existing.length > 0 ? existing[0] : this.app.workspace.getRightLeaf(false)!;
    }
    if (leaf) {
      const state: Record<string, unknown> = {};
      if (workingDir) state.workingDir = workingDir;
      if (yoloMode) state.yoloMode = yoloMode;
      if (continueSession) state.continueSession = continueSession;
      await leaf.setViewState({
        type: VIEW_TYPE,
        active: true,
        state,
      });
      this.app.workspace.revealLeaf(leaf);
      // Focus the terminal after the leaf is revealed
      setTimeout(() => {
        const view = leaf.view;
        if (view instanceof TerminalView && view.term) {
          view.term.focus();
        }
      }, 50);
    }
  }

  async sendTextToTerminal(text: string): Promise<boolean> {
    let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const needsNewTab = leaves.length === 0;
    if (needsNewTab) {
      await this.createNewTab();
      leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    }
    if (leaves.length === 0) return false;

    // Prefer the most recently focused Claude tab, fall back to first
    let leaf = leaves[0];
    if (this.lastActiveTerminalLeaf && leaves.includes(this.lastActiveTerminalLeaf)) {
      leaf = this.lastActiveTerminalLeaf;
    }
    const view = leaf.view;

    if (!(view instanceof TerminalView)) return false;

    if (needsNewTab) {
      // Wait for process to start
      let attempts = 0;
      while ((!view.isShellRunning || !view.hasOutput) && attempts < 100) {
        await new Promise((r) => setTimeout(r, 50));
        attempts++;
      }
      // Additional delay for Claude to fully initialize after first output
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!view.isShellRunning) return false;

    view.writeToShell(text);

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (view.term) {
      view.term.focus();
    }
    return true;
  }
}
