import type { ShellOptions, ShellCallbacks, IShellManager } from "./shell-interface";
import type { Backend, PluginData } from "./types";
import type { SpriteManager } from "./sprite-manager";
import { IDE_RELAY_SCRIPT } from "./ide-relay";
import { createAuthWebSocket, WS_OPEN, type CompatWebSocket } from "./ws-compat";

export class RemoteShellManager implements IShellManager {
  private ws: CompatWebSocket | null = null;
  private callbacks: ShellCallbacks | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _isRunning = false;
  private _exitHandled = false;
  private lastCmd: string | null = null;
  private lastCols = 80;
  private lastRows = 24;

  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private static readonly MAX_RECONNECT_DELAY = 30000;
  // Show reconnecting overlay only after this many attempts
  private static readonly SILENT_RETRIES = 3;

  constructor(
    private getBackend: () => Backend,
    private pluginData: PluginData,
    private spriteManager: SpriteManager,
  ) {}

  get isRunning(): boolean {
    return this._isRunning;
  }

  // Reject shell metacharacters to prevent command injection via additionalFlags
  private static sanitizeFlags(flags: string | null | undefined): string | null {
    if (!flags) return null;
    // Only allow flags that look like CLI arguments (alphanumeric, dashes, dots, equals, commas, spaces)
    if (/[;&|`$(){}\\!\n\r<>'"#]/.test(flags)) {
      console.warn('[RemoteShell] additionalFlags rejected — contains shell metacharacters');
      return null;
    }
    return flags.trim();
  }

  start(opts: ShellOptions, callbacks: ShellCallbacks): void {
    this.stop();
    this.callbacks = callbacks;
    this._isRunning = false;
    this._exitHandled = false;

    // Build the command to run on the Sprite
    const backend = this.getBackend();

    // Build CLI command
    let cliCmd = backend.binary;
    if (backend.id === 'claude') cliCmd += ' --ide';
    if (opts.yoloMode && backend.yoloFlag) cliCmd += ' ' + backend.yoloFlag;
    const sanitizedFlags = RemoteShellManager.sanitizeFlags(this.pluginData.additionalFlags);
    if (sanitizedFlags) cliCmd += ' ' + sanitizedFlags;

    if (opts.continueSession && backend.resumeFlag) {
      if (backend.resumeIsSubcommand) {
        cliCmd = `${backend.binary} ${backend.resumeFlag}`;
        if (sanitizedFlags) cliCmd += ' ' + sanitizedFlags;
      } else {
        cliCmd += ' ' + backend.resumeFlag;
      }
    }

    // Set environment and run from the vault working directory
    const envVars = 'CLAUDE_CODE_SSE_PORT=9501 ENABLE_IDE_INTEGRATION=true';
    const fullCmd = `cd /home/sprite/obsidian && ${envVars} ${cliCmd}`;

    // Async connection
    this.connectAsync(fullCmd, opts, callbacks).catch(err => {
      callbacks.onStderr(`\r\n[Connection error: ${(err as Error).message}]\r\n`);
      callbacks.onExit(1, null);
    });
  }

  private async connectAsync(
    cmd: string,
    opts: ShellOptions,
    callbacks: ShellCallbacks
  ): Promise<void> {
    await this.spriteManager.ensureSprite();

    // Ensure Claude Code and terminal server are installed on the Sprite.
    // This is the primary setup path — idempotent (fast no-op if already done).
    await this.spriteManager.ensureClaudeInstalled();

    // Upload IDE relay script before starting the terminal session
    try {
      await this.spriteManager.uploadFile('/home/sprite/ide-relay.js', IDE_RELAY_SCRIPT);
      console.log('[RemoteShell] IDE relay script uploaded');
    } catch (err) {
      console.warn('[RemoteShell] IDE relay upload failed:', err);
    }

    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    this.lastCmd = cmd;
    this.lastCols = cols;
    this.lastRows = rows;

    console.log('[RemoteShell] cols:', cols, 'rows:', rows);
    console.log('[RemoteShell] cmd:', cmd);

    await this.openWebSocket(callbacks);

    // Give connection a moment to stabilize, then send the actual command.
    // Start the IDE relay as a background process first, then run the main command.
    // The relay needs ~1s to start listening before Claude Code can discover it.
    await new Promise(r => setTimeout(r, 300));
    this.write(
      '{ pkill -f "node /home/sprite/ide-relay.js" 2>/dev/null; ' +
      'node /home/sprite/ide-relay.js > /tmp/relay.log 2>&1 & ' +
      'sleep 1; } 2>/dev/null\n'
    );
    // Wait for relay to start, then clear the screen and run the user-facing command
    setTimeout(() => {
      this.write('clear\n');
      setTimeout(() => this.write(cmd + '\n'), 100);
    }, 1200);
  }

  private async openWebSocket(
    callbacks: ShellCallbacks
  ): Promise<void> {
    // Get fresh ticket and URL for each connection attempt
    const serverUrl = await this.spriteManager.getTerminalServerUrl();
    const ticket = await this.spriteManager.getTerminalTicket();

    // Connect to custom terminal server on the sprite
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?cols=${this.lastCols}&rows=${this.lastRows}`;

    console.log('[RemoteShell] connecting to:', wsUrl);

    return new Promise((resolve, reject) => {
      try {
        this.ws = createAuthWebSocket(wsUrl, ticket);
      } catch (err) {
        reject(err);
        return;
      }

      const onOpen = () => {
        this._isRunning = true;
        const priorAttempts = this.reconnectAttempts;
        const wasReconnecting = priorAttempts > 0;
        this.reconnectAttempts = 0;
        cleanup();
        if (wasReconnecting) {
          // Send resize to sync terminal dimensions
          this.resize(this.lastCols, this.lastRows);
          if (this.lastCmd) {
            setTimeout(() => {
              // WS drop kills the bash session — always restart relay + Claude
              console.log(`[RemoteShell] reconnect succeeded (attempt ${priorAttempts})`);
              this.write(
                '{ pkill -f "node /home/sprite/ide-relay.js" 2>/dev/null; ' +
                'node /home/sprite/ide-relay.js > /tmp/relay.log 2>&1 & ' +
                'sleep 1; } 2>/dev/null\n'
              );
              setTimeout(() => {
                this.write('clear\n');
                setTimeout(() => this.write(this.lastCmd + '\n'), 100);
              }, 1200);
              callbacks.onReconnected?.();
            }, 300);
          } else {
            callbacks.onReconnected?.();
          }
        }
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.ws?.removeListener('open', onOpen);
        this.ws?.removeListener('error', onError);
      };

      this.ws.on('open', onOpen);
      this.ws.on('error', onError);

      // Wire up persistent handlers — terminal server sends JSON-framed messages
      this.ws.on('message', (data: unknown) => {
        const text =
          typeof data === 'string'
            ? data
            : new TextDecoder().decode(data as ArrayBuffer);

        // Try to parse as JSON control message
        try {
          const msg = JSON.parse(text);
          console.debug('[RemoteShell] ws msg:', msg.type);
          if (msg.type === 'data' && msg.data != null) {
            callbacks.onStdout(msg.data);
            return;
          }
          if (msg.type === 'exit') {
            this._isRunning = false;
            if (!this._exitHandled) {
              this._exitHandled = true;
              callbacks.onExit(msg.exit_code ?? 0, null);
            }
            return;
          }
          // All other JSON control messages — ignore
          return;
        } catch {
          // Not JSON — treat as raw terminal output
        }
        callbacks.onStdout(text);
      });

      this.ws.on('close', (code: number, reason: unknown) => {
        const reasonStr = String(reason || '');
        console.log(`[RemoteShell] ws close: code=${code} reason="${reasonStr}" isRunning=${this._isRunning} exitHandled=${this._exitHandled}`);
        if (this._isRunning) {
          // Unexpected disconnect — try reconnect
          this._isRunning = false;
          this.attemptReconnect(callbacks);
        } else if (!this._exitHandled) {
          this._exitHandled = true;
          callbacks.onExit(code === 1000 ? 0 : code, null);
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error('[RemoteShell] ws error:', err.message);
      });
    });
  }

  write(data: string): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    // Send resize as a control message over the WebSocket
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify({ __ctrl: 'resize', cols, rows }));
    }
  }

  stop(): void {
    this._isRunning = false;
    this._exitHandled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private attemptReconnect(
    callbacks: ShellCallbacks
  ): void {
    if (this.reconnectAttempts >= RemoteShellManager.MAX_RECONNECT_ATTEMPTS) {
      callbacks.onStdout('\r\n[Connection lost after max retries.]\r\n');
      callbacks.onExit(1, null);
      return;
    }

    this.reconnectAttempts++;
    // Fast retries for transient 503s, then exponential backoff
    const delay = this.reconnectAttempts <= RemoteShellManager.SILENT_RETRIES
      ? 500 * this.reconnectAttempts  // 500ms, 1s, 1.5s
      : Math.min(1000 * Math.pow(2, this.reconnectAttempts - RemoteShellManager.SILENT_RETRIES - 1), RemoteShellManager.MAX_RECONNECT_DELAY);
    console.log(`[RemoteShell] reconnect attempt ${this.reconnectAttempts}/${RemoteShellManager.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    // Only show reconnecting overlay after silent retries exhausted
    if (this.reconnectAttempts > RemoteShellManager.SILENT_RETRIES) {
      callbacks.onReconnecting?.();
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._isRunning = true; // Optimistically set so onclose triggers reconnect
      this.openWebSocket(callbacks).catch(() => {
        this._isRunning = false;
        this.attemptReconnect(callbacks);
      });
    }, delay);
  }
}
