import { Plugin, WorkspaceLeaf, Menu, TFolder } from "obsidian";
import { TerminalView, VIEW_TYPE } from "./terminal-view";
import { IdeServer } from "./ide-server";
import { ClaudeSidebarSettingsTab } from "./settings";
import { CLI_BACKENDS } from "./backends";
import type { PluginData } from "./types";

export default class VaultTerminalPlugin extends Plugin {
  pluginData: PluginData = {};
  ideServer: IdeServer | null = null;
  private lastActiveTerminalLeaf: WorkspaceLeaf | null = null;
  private lastRibbonClick = 0;

  async onload() {
    this.pluginData = await this.loadData() || {};
    this.lastActiveTerminalLeaf = null;

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

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

    // Register folder context menu
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
      })
    );

    // IDE integration: track editor content and selection changes
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.ideServer?.pushSelection();
      })
    );

    // Capture selection changes (cursor moves, text highlights) via DOM event
    const selHandler = () => this.ideServer?.pushSelection();
    document.addEventListener("selectionchange", selHandler);
    this.register(() => document.removeEventListener("selectionchange", selHandler));

    // Start IDE integration WebSocket server
    this.startIdeServer();

    this.addSettingTab(new ClaudeSidebarSettingsTab(this.app, this));
  }

  onunload() {
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
    if (this.pluginData.enableIdeIntegration === false) return;
    this.ideServer = new IdeServer(this.app, () => this.getVaultPath());
    this.ideServer.start();
  }

  stopIdeServer(): void {
    this.ideServer?.stop();
    this.ideServer = null;
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
    const leaf = this.app.workspace.getRightLeaf(false);
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
      while ((!view.proc || !view.hasOutput) && attempts < 100) {
        await new Promise((r) => setTimeout(r, 50));
        attempts++;
      }
      // Additional delay for Claude to fully initialize after first output
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!view.proc || view.proc.killed) return false;

    view.proc.stdin?.write(text);

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (view.term) {
      view.term.focus();
    }
    return true;
  }
}
