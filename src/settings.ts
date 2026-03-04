import { App, PluginSettingTab, Setting, Platform } from "obsidian";
import type { PluginData } from "./types";
import { CLI_BACKENDS } from "./backends";

export interface SettingsHost {
  pluginData: PluginData;
  ideServer: { port: number | null } | null;
  saveData(data: PluginData): Promise<void>;
  startIdeServer(): void;
  stopIdeServer(): void;
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
      .setName("CLI flags")
      .setDesc("Flags appended to every CLI session.")
      .addText(text => text
        .setPlaceholder("--model claude-opus-4-6")
        .setValue(this.plugin.pluginData.additionalFlags || "")
        .onChange(async (value) => {
          this.plugin.pluginData.additionalFlags = value.trim() || null;
          await this.plugin.saveData(this.plugin.pluginData);
        }));

    if (!Platform?.isMobile) {
      new Setting(containerEl)
        .setName("IDE integration")
        .setDesc(
          "Let Claude see your open files and selections automatically." +
          (this.plugin.wsPort ? ` (port ${this.plugin.wsPort})` : "")
        )
        .addToggle(toggle => toggle
          .setValue(this.plugin.pluginData.enableIdeIntegration !== false)
          .onChange(async (value) => {
            this.plugin.pluginData.enableIdeIntegration = value;
            await this.plugin.saveData(this.plugin.pluginData);
            if (value && !this.plugin.wsServer) {
              this.plugin.startIdeServer();
            } else if (!value && this.plugin.wsServer) {
              this.plugin.stopIdeServer();
            }
            this.display();
          }));
    }
  }
}
