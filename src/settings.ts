import { App, PluginSettingTab, Setting, Platform, Notice } from "obsidian";
import * as fs from "fs";
import type { PluginData } from "./types";
import { CLI_BACKENDS } from "./backends";
import { expandHome } from "./binary-path";

export interface SettingsHost {
  pluginData: PluginData;
  ideServer: { port: number | null } | null;
  saveData(data: PluginData): Promise<void>;
  startIdeServer(): void;
  stopIdeServer(): void;
  updateRuntimeMode(): void;
  destroySprite?(): Promise<void>;
}

export class ClaudeSidebarSettingsTab extends PluginSettingTab {
  private plugin: SettingsHost & { wsPort?: number | null; wsServer?: unknown };

  constructor(app: App, plugin: SettingsHost & { wsPort?: number | null; wsServer?: unknown }) {
    super(app, plugin as never);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const mode = this.plugin.pluginData.runtimeMode ?? 'local';

    // Runtime Mode dropdown
    new Setting(containerEl)
      .setName("Runtime mode")
      .setDesc("Local runs Claude Code on this device. Sprites.dev runs it in a cloud VM (required for mobile).")
      .addDropdown(drop => {
        drop.addOption('local', 'Local');
        drop.addOption('sprites', 'Sprites.dev');
        drop.setValue(mode);
        drop.onChange(async (value) => {
          this.plugin.pluginData.runtimeMode = value as 'local' | 'sprites';
          await this.plugin.saveData(this.plugin.pluginData);
          this.plugin.updateRuntimeMode();
          this.display();
        });
      });

    // Mobile warning for local mode
    if (Platform?.isMobile && mode === 'local') {
      const notice = containerEl.createDiv({ cls: 'setting-item-description' });
      notice.style.color = 'var(--text-warning, orange)';
      notice.style.marginBottom = '1em';
      notice.setText('Local mode requires a desktop device. Switch to Sprites.dev for mobile.');
    }

    // Sprites.dev configuration section
    if (mode === 'sprites') {
      new Setting(containerEl)
        .setName("Sprites API token")
        .setDesc("Your Sprites.dev API token.")
        .addText(text => {
          text.inputEl.type = 'password';
          text
            .setPlaceholder('spr_...')
            .setValue(this.plugin.pluginData.spritesApiToken || '')
            .onChange(async (value) => {
              this.plugin.pluginData.spritesApiToken = value.replace(/\s/g, '') || null;
              await this.plugin.saveData(this.plugin.pluginData);
              this.plugin.updateRuntimeMode();
            });
        });

      const spriteSetting = new Setting(containerEl)
        .setName("Sprite status")
        .setDesc("Manage the remote Sprites.dev VM.");

      spriteSetting.addButton(btn => {
        btn.setButtonText('Destroy Sprite');
        btn.setWarning();
        btn.onClick(async () => {
          if (this.plugin.destroySprite) {
            await this.plugin.destroySprite();
            new Notice('Sprite destroyed.');
            this.display();
          } else {
            new Notice('Destroy Sprite is not available.');
          }
        });
      });
    }

    // Existing settings — always shown
    new Setting(containerEl)
      .setName("CLI backend")
      .setDesc("Which coding agent CLI to run in the sidebar.")
      .addDropdown(drop => {
        for (const [key, backend] of Object.entries(CLI_BACKENDS)) {
          drop.addOption(key, backend.label);
        }
        drop.setValue(this.plugin.pluginData.cliBackend || "claude");
        drop.onChange(async (value) => {
          this.plugin.pluginData.cliBackend = value;
          await this.plugin.saveData(this.plugin.pluginData);
        });
      });

    // Per-backend custom binary paths — local runtime mode only
    if (mode === 'local') {
      new Setting(containerEl).setName('Binary paths').setHeading();
      for (const [key, backend] of Object.entries(CLI_BACKENDS)) {
        new Setting(containerEl)
          .setName(`${backend.label} binary path`)
          .setDesc(`Custom path or command name for the ${backend.label} executable. `
                 + `Leave empty to resolve "${backend.binary}" via PATH.`)
          .addText(text => text
            .setPlaceholder(backend.binary)
            .setValue(this.plugin.pluginData.binaryPaths?.[key] || "")
            .onChange(async (value) => {
              const paths = { ...(this.plugin.pluginData.binaryPaths || {}) };
              const v = value.trim();
              if (v) paths[key] = v; else delete paths[key];
              this.plugin.pluginData.binaryPaths =
                Object.keys(paths).length ? paths : undefined;
              await this.plugin.saveData(this.plugin.pluginData);
              // Inline existence hint: only when the value looks like a path
              // (contains a separator), not a bare PATH-resolved command name.
              if (v && /[/\\]/.test(v)) {
                if (!fs.existsSync(expandHome(v))) {
                  new Notice("Binary not found at that path");
                }
              }
            }));
      }
    }

    new Setting(containerEl)
      .setName("Default working directory")
      .setDesc("Absolute path or relative to vault root. Leave empty for vault root.")
      .addText(text => text
        .setPlaceholder("/Users/you/project")
        .setValue(this.plugin.pluginData.defaultWorkingDir || "")
        .onChange(async (value) => {
          this.plugin.pluginData.defaultWorkingDir = value.trim() || null;
          await this.plugin.saveData(this.plugin.pluginData);
        }));

    new Setting(containerEl)
      .setName("Auto-resume sessions")
      .setDesc("Automatically resume the previous Claude session when Obsidian restarts.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.pluginData.autoResume !== false)
        .onChange(async (value) => {
          this.plugin.pluginData.autoResume = value;
          await this.plugin.saveData(this.plugin.pluginData);
        }));

    new Setting(containerEl)
      .setName("CLI flags")
      .setDesc("Flags appended to every CLI session.")
      .addText(text => text
        .setPlaceholder("--model claude-opus-4-6")
        .setValue(this.plugin.pluginData.additionalFlags || "")
        .onChange(async (value) => {
          this.plugin.pluginData.additionalFlags = value.trim() || null;
          await this.plugin.saveData(this.plugin.pluginData);
        }));

  }
}
