import * as http from "http";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { App, Platform, TFile, MarkdownView } from "obsidian";
import { wsParseFrame, wsMakeFrame, WS_MAGIC_GUID } from "./ws-framing";
import { getToolCatalog, handleToolCall, ToolError } from "./ide-tools";
import { DiffModal } from "./diff-modal";
import type { WsClient, SelectionParams } from "./types";

export class IdeServer {
  private wsServer: http.Server | null = null;
  private wsClients = new Set<WsClient>();
  private ideAuthToken: string | null = null;
  private lockFilePath: string | null = null;
  private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelection: SelectionParams | null = null;
  private pendingDiffPromises = new Map<number, (result: string) => void>();

  public port: number | null = null;

  constructor(
    private app: App,
    private getVaultPath: () => string,
  ) {}

  start(): void {
    if (Platform?.isMobile) return;
    this.ideAuthToken = crypto.randomUUID();
    this.cleanStaleLockFiles();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket, head) => {
      this.handleWsUpgrade(req, socket, head);
    });
    const tryListen = (attemptsLeft: number): void => {
      const port = 10000 + Math.floor(Math.random() * 55535);
      server.once("error", () => {
        if (attemptsLeft > 0) {
          tryListen(attemptsLeft - 1);
        } else {
          console.warn("Claude IDE integration: failed to start WebSocket server after 3 attempts");
        }
      });
      server.listen(port, "127.0.0.1", () => {
        this.wsServer = server;
        this.port = port;
        this.writeLockFile();
        console.log(`Claude IDE integration: WebSocket server on port ${port}`);
      });
    };
    tryListen(2);
  }

  stop(): void {
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
      this.selectionDebounceTimer = null;
    }
    for (const client of this.wsClients) {
      try { client.socket.destroy(); } catch (_e) {}
    }
    this.wsClients.clear();
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    if (this.lockFilePath) {
      try { fs.unlinkSync(this.lockFilePath); } catch (_e) {}
      this.lockFilePath = null;
    }
    this.port = null;
  }

  pushSelection(): void {
    if (this.wsClients.size === 0) return;
    if (this.selectionDebounceTimer) clearTimeout(this.selectionDebounceTimer);
    this.selectionDebounceTimer = setTimeout(() => {
      // Use getMostRecentLeaf() to get the editor even when sidebar has focus
      const leaf = this.app.workspace.getMostRecentLeaf();
      const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
      const editor = view?.editor ?? this.app.workspace.activeEditor?.editor;
      const file = view?.file ?? this.app.workspace.getActiveFile();
      if (!file) return;
      const vaultPath = this.getVaultPath();
      const filePath = `${vaultPath}/${file.path}`;
      const text = editor?.getSelection() || "";
      const from = editor?.getCursor("from") || { line: 0, ch: 0 };
      const to = editor?.getCursor("to") || { line: 0, ch: 0 };
      const params: SelectionParams = {
        text,
        filePath,
        fileUrl: `file://${filePath}`,
        selection: {
          start: { line: from.line, character: from.ch },
          end: { line: to.line, character: to.ch },
          isEmpty: !text
        }
      };
      // Preserve last meaningful text selection when focus moves to terminal.
      // Always update if there's selected text or if the active file changed.
      if (text || !this.lastSelection || this.lastSelection.filePath !== filePath) {
        this.lastSelection = params;
      }
      this.sendJsonRpcNotification("selection_changed", params);
    }, 150);
  }

  private handleWsUpgrade(
    req: http.IncomingMessage,
    duplex: import("stream").Duplex,
    _head: Buffer
  ): void {
    const socket = duplex as import("net").Socket;
    const authHeader = req.headers["x-claude-code-ide-authorization"];
    if (authHeader !== this.ideAuthToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      console.warn("Claude IDE integration: rejected connection with invalid auth token");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1")
      .update((Array.isArray(key) ? key[0] : key) + WS_MAGIC_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n" +
      "\r\n"
    );
    const client: WsClient = { socket, buffer: Buffer.alloc(0), fragments: [] };
    this.wsClients.add(client);
    socket.on("data", (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data]);
      this.processWsFrames(client);
    });
    socket.on("close", () => {
      this.wsClients.delete(client);
    });
    socket.on("error", () => {
      this.wsClients.delete(client);
    });
  }

  private processWsFrames(client: WsClient): void {
    while (true) {
      const frame = wsParseFrame(client.buffer);
      if (!frame) break;
      client.buffer = client.buffer.slice(frame.totalLength);
      if (frame.opcode === 0x08) {
        try { client.socket.write(wsMakeFrame(Buffer.alloc(0), 0x08)); } catch (_e) {}
        client.socket.destroy();
        this.wsClients.delete(client);
        return;
      }
      if (frame.opcode === 0x09) {
        try { client.socket.write(wsMakeFrame(frame.payload, 0x0A)); } catch (_e) {}
        continue;
      }
      if (frame.opcode === 0x0A) continue;
      if (frame.opcode === 0x00) {
        client.fragments.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(client.fragments);
          client.fragments = [];
          this.handleMcpMessage(client, full.toString("utf8"));
        }
        continue;
      }
      if (frame.opcode === 0x01) {
        if (frame.fin) {
          this.handleMcpMessage(client, frame.payload.toString("utf8"));
        } else {
          client.fragments = [frame.payload];
        }
      }
    }
  }

  private handleMcpMessage(client: WsClient, text: string): void {
    let msg: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { msg = JSON.parse(text); } catch (_e) { return; }
    if (msg.method === "initialize") {
      this.sendJsonRpc(client, msg.id!, {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "obsidian-claude-sidebar", version: "1.7.2" },
        capabilities: { tools: {} }
      });
    } else if (msg.method === "notifications/initialized") {
      // No response needed
    } else if (msg.method === "tools/list") {
      this.sendJsonRpc(client, msg.id!, { tools: getToolCatalog() });
    } else if (msg.method === "tools/call") {
      const toolName = msg.params?.name ?? "";
      const args = msg.params?.arguments ?? {};
      const id = msg.id!;
      const ctx = {
        app: this.app,
        getVaultPath: this.getVaultPath,
        showDiff: (filePath: string, oldContent: string, newContent: string) => {
          const vaultPath = this.getVaultPath();
          return DiffModal.show(
            this.app,
            filePath,
            oldContent,
            newContent,
            async (relPath: string, content: string) => {
              const file = this.app.vault.getAbstractFileByPath(relPath);
              if (file && file instanceof TFile) {
                await this.app.vault.modify(file, content);
              }
            }
          );
        },
        getLastSelection: () => this.lastSelection,
        pendingDiffPromises: this.pendingDiffPromises,
      };
      handleToolCall(ctx, toolName, args).then(result => {
        this.sendJsonRpc(client, id, result);
      }).catch(err => {
        if (err instanceof ToolError) {
          this.sendJsonRpcError(client, id, err.code, err.message);
        } else {
          this.sendJsonRpcError(client, id, -32000, String(err));
        }
      });
    }
  }

  private sendJsonRpc(client: WsClient, id: number, result: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    try { client.socket.write(wsMakeFrame(msg)); } catch (_e) {}
  }

  private sendJsonRpcError(client: WsClient, id: number, code: number, message: string): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
    try { client.socket.write(wsMakeFrame(msg)); } catch (_e) {}
  }

  private sendJsonRpcNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = wsMakeFrame(msg);
    for (const client of this.wsClients) {
      try { client.socket.write(frame); } catch (_e) {}
    }
  }

  private writeLockFile(): void {
    const lockDir = path.join(os.homedir(), ".claude", "ide");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, `${this.port}.lock`);
    const lockData = {
      pid: process.pid,
      workspaceFolders: [this.getVaultPath()],
      ideName: "Obsidian",
      transport: "ws",
      authToken: this.ideAuthToken
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
    this.lockFilePath = lockPath;
  }

  private cleanStaleLockFiles(): void {
    const lockDir = path.join(os.homedir(), ".claude", "ide");
    try {
      if (!fs.existsSync(lockDir)) return;
      const files = fs.readdirSync(lockDir);
      for (const file of files) {
        if (!file.endsWith(".lock")) continue;
        const lockPath = path.join(lockDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (data.ideName !== "Obsidian") continue;
          try { process.kill(data.pid, 0); } catch (_e) {
            fs.unlinkSync(lockPath);
          }
        } catch (_e) {
          try { fs.unlinkSync(lockPath); } catch (_e2) {}
        }
      }
    } catch (_e) {}
  }
}
