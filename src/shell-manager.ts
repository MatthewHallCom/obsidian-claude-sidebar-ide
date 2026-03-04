import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { StringDecoder } from "string_decoder";
import type { Backend, PluginData } from "./types";

// PTY scripts are injected at build time by esbuild as base64-encoded strings.
// See terminal_pty.py and terminal_win.py for readable source. Rebuild with: ./build.sh
declare const __PTY_SCRIPT_B64__: string;
declare const __WIN_PTY_SCRIPT_B64__: string;

export interface ShellOptions {
  workingDir?: string | null;
  yoloMode?: boolean;
  continueSession?: boolean;
  cols?: number;
  rows?: number;
}

export interface ShellCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export class ShellManager {
  proc: ChildProcess | null = null;
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private callbacks: ShellCallbacks | null = null;

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
    const additionalFlags = this.pluginData.additionalFlags;
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
}
