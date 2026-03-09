import type { ClaudeBridge } from './types';
import { createAuthWebSocket } from '../ws-compat';
import type { CompatWebSocket } from '../ws-compat';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseClaudeLine(
  line: string,
  discarding: boolean,
  textDeltaCb: (text: string) => void,
  completeCb: (fullText: string) => void,
): boolean {
  // Returns updated discarding flag
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return discarding;
  }

  if (d.type === 'assistant') {
    if (!discarding) {
      const contents: any[] = d.message?.content ?? [];
      for (const entry of contents) {
        if (entry.type === 'text' && typeof entry.text === 'string') {
          textDeltaCb(entry.text);
        }
      }
    }
  } else if (d.type === 'result') {
    const result: string = typeof d.result === 'string' ? d.result : '';
    if (!discarding) {
      completeCb(result);
    }
    return false; // reset discarding
  }
  // 'system', 'rate_limit_event', and others are ignored

  return discarding;
}

// ---------------------------------------------------------------------------
// LocalClaudeBridge
// ---------------------------------------------------------------------------

export class LocalClaudeBridge implements ClaudeBridge {
  private proc: ReturnType<typeof import('child_process').spawn> | null = null;
  private textDeltaCb: (text: string) => void = () => {};
  private completeCb: (fullText: string) => void = () => {};
  private errorCb: (error: Error) => void = () => {};
  private discarding = false;
  private lineBuffer = '';

  async start(): Promise<void> {
    // Lazy-require child_process (Node.js / Electron desktop only)
    const { spawn } = require('child_process') as typeof import('child_process');

    const env = { ...process.env };
    delete env['CLAUDECODE'];

    this.proc = spawn(
      'claude',
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
      ],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf8');
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.discarding = parseClaudeLine(
            trimmed,
            this.discarding,
            this.textDeltaCb,
            this.completeCb,
          );
        }
      }
    });

    this.proc.stderr?.on('data', (_chunk: Buffer) => {
      // ignore stderr
    });

    this.proc.on('error', (err: Error) => {
      this.errorCb(err);
    });

    this.proc.on('close', (code: number | null) => {
      if (code !== 0 && code !== null) {
        this.errorCb(new Error(`Claude process exited with code ${code}`));
      }
    });
  }

  sendMessage(text: string): void {
    if (!this.proc?.stdin) return;
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    });
    this.proc.stdin.write(msg + '\n');
  }

  cancel(): void {
    this.discarding = true;
    // Do NOT send SIGINT — that would kill the process.
    // discard flag is reset when next 'result' event arrives.
  }

  onTextDelta(cb: (text: string) => void): void {
    this.textDeltaCb = cb;
  }

  onComplete(cb: (fullText: string) => void): void {
    this.completeCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb;
  }

  destroy(): void {
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// SpritesClaudeBridge
// ---------------------------------------------------------------------------

export class SpritesClaudeBridge implements ClaudeBridge {
  private ws: CompatWebSocket | null = null;
  private textDeltaCb: (text: string) => void = () => {};
  private completeCb: (fullText: string) => void = () => {};
  private errorCb: (error: Error) => void = () => {};
  private discarding = false;
  private lineBuffer = '';

  constructor(private readonly spriteManager: any) {}

  async start(): Promise<void> {
    await this.spriteManager.ensureSprite();
    await this.spriteManager.ensureClaudeInstalled();

    const ticket: string = await this.spriteManager.getTerminalTicket();
    const serverUrl: string = await this.spriteManager.getTerminalServerUrl();

    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?cols=80&rows=24`;
    const ws = createAuthWebSocket(wsUrl, ticket);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(
          'claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose\n'
        );
        resolve();
      });

      ws.on('error', (err: Error) => {
        reject(err);
      });

      ws.on('message', (raw: string) => {
        this.handleMessage(raw);
      });

      ws.on('close', (_code: number, _reason: string) => {
        // nothing special needed on close
      });
    });
  }

  private handleMessage(raw: string): void {
    let outer: any;
    try {
      outer = JSON.parse(raw);
    } catch {
      return;
    }

    if (outer.type !== 'data' || typeof outer.data !== 'string') return;

    this.lineBuffer += outer.data;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        this.discarding = parseClaudeLine(
          trimmed,
          this.discarding,
          this.textDeltaCb,
          this.completeCb,
        );
      }
    }
  }

  sendMessage(text: string): void {
    if (!this.ws) return;
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    });
    this.ws.send(msg + '\n');
  }

  cancel(): void {
    this.discarding = true;
    // Reset when next 'result' event arrives.
  }

  onTextDelta(cb: (text: string) => void): void {
    this.textDeltaCb = cb;
  }

  onComplete(cb: (fullText: string) => void): void {
    this.completeCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb;
  }

  destroy(): void {
    this.ws?.close();
    this.ws = null;
  }
}
