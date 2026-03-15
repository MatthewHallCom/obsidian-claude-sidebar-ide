import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { StringDecoder } from "string_decoder";
import type { Backend, PluginData } from "./types";
import type { ShellOptions, ShellCallbacks, IShellManager } from "./shell-interface";

export type { ShellOptions, ShellCallbacks };

// PTY scripts are injected at build time by esbuild as base64-encoded strings.
// See terminal_pty.py and terminal_win.py for readable source. Rebuild with: ./build.sh
declare const __PTY_SCRIPT_B64__: string;
declare const __WIN_PTY_SCRIPT_B64__: string;

const NOTIFY_HOOK_SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const http = require("http");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const lockDir = path.join(require("os").homedir(), ".claude", "ide");
    if (!fs.existsSync(lockDir)) { out(); return; }
    const files = fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
    for (const f of files) {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(lockDir, f), "utf8"));
        if (lock.ideName !== "Obsidian") continue;
        const port = parseInt(f.replace(".lock", ""), 10);
        const body = JSON.stringify({
          type: "notification",
          notification_type: data.notification_type || null,
          message: data.message || null,
        });
        const req = http.request({
          hostname: "127.0.0.1", port, path: "/notify", method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-claude-code-ide-authorization": lock.authToken,
            "Content-Length": Buffer.byteLength(body),
          },
        });
        req.on("error", () => {});
        req.end(body);
      } catch (_e) {}
    }
  } catch (_e) {}
  out();
});
function out() { process.stdout.write(JSON.stringify({ continue: true })); }
`;

const STOP_HOOK_SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const http = require("http");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const lockDir = path.join(require("os").homedir(), ".claude", "ide");
    if (!fs.existsSync(lockDir)) { out(); return; }
    const files = fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
    for (const f of files) {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(lockDir, f), "utf8"));
        if (lock.ideName !== "Obsidian") continue;
        const port = parseInt(f.replace(".lock", ""), 10);
        const body = JSON.stringify({ type: "stop" });
        const req = http.request({
          hostname: "127.0.0.1", port, path: "/notify", method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-claude-code-ide-authorization": lock.authToken,
            "Content-Length": Buffer.byteLength(body),
          },
        });
        req.on("error", () => {});
        req.end(body);
      } catch (_e) {}
    }
  } catch (_e) {}
  out();
});
function out() { process.stdout.write(JSON.stringify({ continue: true })); }
`;

export class ShellManager implements IShellManager {
  proc: ChildProcess | null = null;
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private callbacks: ShellCallbacks | null = null;
  private hookSettingsPath: string | null = null;

  constructor(
    private getBackend: () => Backend,
    private pluginData: PluginData,
    private getVaultPath: () => string,
    private getIdeServerPort: () => number | null,
  ) {}

  start(opts: ShellOptions, callbacks: ShellCallbacks): void {
    this.stop();
    this.callbacks = callbacks;

    const {
      workingDir = null,
      yoloMode = false,
      continueSession = false,
      cols = 80,
      rows = 24,
    } = opts;

    const defaultDir = this.pluginData.defaultWorkingDir;
    const vaultPath = this.getVaultPath();
    const resolvedDefault = defaultDir ? path.resolve(vaultPath, defaultDir) : vaultPath;
    const cwd = workingDir || resolvedDefault;

    // Persist last working directory for resume
    this.pluginData.lastCwd = cwd;

    // Install Claude Code notification hooks
    const hookSettingsPath = ShellManager.installHooks(cwd);
    if (hookSettingsPath) {
      this.hookSettingsPath = hookSettingsPath;
    }

    const isWindows = process.platform === "win32";
    const shell = isWindows
      ? (process.env.COMSPEC || "cmd.exe")
      : (process.env.SHELL || "/bin/bash");

    // PTY scripts embedded as base64 for Obsidian plugin directory compatibility
    // See terminal_pty.py and terminal_win.py for readable source. Rebuild with: ./build.sh
    const scriptB64 = isWindows ? __WIN_PTY_SCRIPT_B64__ : __PTY_SCRIPT_B64__;
    const scriptName = isWindows ? "claude_sidebar_win.py" : "claude_sidebar_pty.py";
    const ptyPath = path.join(os.tmpdir(), scriptName);
    // Always write to ensure current version (overwrites stale cached copies)
    const ptyScript = Buffer.from(scriptB64, "base64").toString("utf-8");
    fs.writeFileSync(ptyPath, ptyScript, { mode: 0o755 });

    // Find Python on Windows - try multiple methods since GUI apps have PATH issues
    let cmd = "python3";
    if (isWindows) {
      cmd = null as unknown as string;
      // 1. Try 'py' launcher (installed by python.org installer to C:\Windows)
      try {
        execSync("py --version", { stdio: "ignore", timeout: 2000 });
        cmd = "py";
      } catch (e) {}
      // 2. Try 'where.exe python' and use first result that isn't the WindowsApps alias
      if (!cmd) {
        try {
          const whereOutput = execSync("where.exe python", { encoding: "utf8", timeout: 2000 });
          const pythonPaths = whereOutput.split(/\r?\n/).map(p => p.trim()).filter(p => p && !p.includes("WindowsApps"));
          // Prefer .bat shims (pyenv-win), otherwise use first valid path
          const batShim = pythonPaths.find(p => p.toLowerCase().endsWith(".bat"));
          if (batShim) {
            cmd = batShim;
          } else if (pythonPaths.length > 0) {
            cmd = pythonPaths[0];
          }
        } catch (e) {}
      }
      // 3. Fall back to 'python' and hope for the best
      if (!cmd) {
        cmd = "python";
      }
    }

    const backend = this.getBackend();
    const idePort = this.getIdeServerPort();
    let cliCmd = backend.binary;
    if (backend.binary === "claude" && idePort) cliCmd += " --ide";
    if (yoloMode && backend.yoloFlag) cliCmd += " " + backend.yoloFlag;
    const additionalFlags = ShellManager.sanitizeFlags(this.pluginData.additionalFlags);
    if (additionalFlags) cliCmd += " " + additionalFlags;
    let baseCmd = cliCmd;
    if (continueSession && backend.resumeFlag) {
      if (backend.resumeIsSubcommand) {
        // e.g. "codex resume --last" — replace the whole command
        cliCmd = backend.binary + " " + backend.resumeFlag;
        if (additionalFlags) cliCmd += " " + additionalFlags;
      } else {
        cliCmd += " " + backend.resumeFlag;
      }
    }
    const shellCmd = continueSession
      ? `${cliCmd} || ${baseCmd} || true; exec $SHELL -i`
      : `${cliCmd} || true; exec $SHELL -i`;
    const args = isWindows
      ? [ptyPath, String(cols), String(rows), shell]
      : [ptyPath, String(cols), String(rows), shell, "-lc", shellCmd];

    // Get PATH from user's login shell (GUI apps don't inherit shell config)
    let shellEnv: Record<string, string> = { ...process.env as Record<string, string>, TERM: "xterm-256color" };
    if (!isWindows) {
      try {
        const shellOutput = execSync(
          `${shell} -lic 'echo "__PATH__"; echo "$PATH"'`,
          { encoding: "utf8", timeout: 2000 }
        );
        // Extract PATH from after the marker (shell integration escapes pollute early output)
        const shellPath = shellOutput.split("__PATH__\n")[1]?.trim().split("\n")[0];
        if (shellPath) {
          shellEnv.PATH = shellPath;
        }
      } catch (e) {
        // Fall back to process.env.PATH if shell init fails
      }
      // Ensure backend-specific paths are available
      const homeDir = process.env.HOME || "";
      const pathHints = (backend.pathHints || []).map(p => p.replace("~", homeDir));
      for (const hint of pathHints) {
        if (hint && shellEnv.PATH && !shellEnv.PATH.includes(hint)) {
          shellEnv.PATH = `${hint}:${shellEnv.PATH}`;
        }
      }
    }

    // IDE integration: set env vars so Claude Code connects to our WebSocket server
    if (backend.binary === "claude" && idePort) {
      shellEnv.CLAUDE_CODE_SSE_PORT = String(idePort);
      shellEnv.ENABLE_IDE_INTEGRATION = "true";
    }

    this.proc = spawn(cmd, args, {
      cwd,
      env: shellEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Use StringDecoder to properly handle UTF-8 boundaries across chunks
    // This prevents replacement characters when multi-byte chars are split
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderrDecoder = new StringDecoder("utf8");

    this.proc.stdout?.on("data", (data: Buffer) => {
      callbacks.onStdout(this.stdoutDecoder.write(data));
    });
    this.proc.stderr?.on("data", (data: Buffer) => {
      callbacks.onStderr(this.stderrDecoder.write(data));
    });
    this.proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      callbacks.onExit(code, signal);
      this.proc = null;
    });
  }

  stop(): void {
    if (this.hookSettingsPath) {
      ShellManager.uninstallHooks(this.hookSettingsPath);
      this.hookSettingsPath = null;
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    // Flush any remaining buffered bytes from decoders
    if (this.stdoutDecoder) {
      const remaining = this.stdoutDecoder.end();
      if (remaining) this.callbacks?.onStdout(remaining);
      this.stdoutDecoder = new StringDecoder("utf8");
    }
    if (this.stderrDecoder) {
      const remaining = this.stderrDecoder.end();
      if (remaining) this.callbacks?.onStderr(remaining);
      this.stderrDecoder = new StringDecoder("utf8");
    }
  }

  write(data: string): void {
    this.proc?.stdin?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.write(`\x1b]RESIZE;${cols};${rows}\x07`);
  }

  get isRunning(): boolean {
    return this.proc != null && !this.proc.killed;
  }

  // Reject shell metacharacters to prevent command injection via additionalFlags
  private static sanitizeFlags(flags: string | null | undefined): string | null {
    if (!flags) return null;
    if (/[;&|`$(){}\\!\n\r<>'"#]/.test(flags)) {
      console.warn('[ShellManager] additionalFlags rejected — contains shell metacharacters');
      return null;
    }
    return flags.trim();
  }

  /** Write Claude Code hook scripts + .claude/settings.local.json to the working directory. */
  static installHooks(cwd: string): string | null {
    try {
      // Write hook scripts to temp dir
      const notifyPath = path.join(os.tmpdir(), "claude_obsidian_notify.cjs");
      const stopPath = path.join(os.tmpdir(), "claude_obsidian_stop.cjs");
      fs.writeFileSync(notifyPath, NOTIFY_HOOK_SCRIPT, { mode: 0o755 });
      fs.writeFileSync(stopPath, STOP_HOOK_SCRIPT, { mode: 0o755 });

      // Write or merge .claude/settings.local.json in the working directory
      const claudeDir = path.join(cwd, ".claude");
      const settingsPath = path.join(claudeDir, "settings.local.json");

      let settings: Record<string, unknown> = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        }
      } catch (_e) {}

      // Build our hook entries
      const obsidianHooks = {
        Notification: [{
          hooks: [{ type: "command", command: `node "${notifyPath}"`, timeout: 5000 }]
        }],
        Stop: [{
          hooks: [{ type: "command", command: `node "${stopPath}"`, timeout: 5000 }]
        }],
      };

      // Merge: preserve existing hooks, add ours
      const existingHooks = (settings.hooks || {}) as Record<string, unknown[]>;
      settings.hooks = { ...existingHooks, ...obsidianHooks };

      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return settingsPath;
    } catch (_e) {
      return null;
    }
  }

  /** Remove Obsidian-managed hook entries from .claude/settings.local.json. */
  static uninstallHooks(settingsPath: string): void {
    try {
      if (!fs.existsSync(settingsPath)) return;
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const hooks = settings.hooks;
      if (!hooks) return;
      delete hooks.Notification;
      delete hooks.Stop;
      // If no hooks remain, remove the hooks key entirely
      if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
      }
      // If settings is now empty, delete the file
      if (Object.keys(settings).length === 0) {
        fs.unlinkSync(settingsPath);
        // Try to remove .claude dir if empty
        try { fs.rmdirSync(path.dirname(settingsPath)); } catch (_e) {}
      } else {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      }
    } catch (_e) {}
  }
}
