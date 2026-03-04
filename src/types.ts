export interface PluginData {
  cliBackend?: string;
  defaultWorkingDir?: string | null;
  additionalFlags?: string | null;
  lastCwd?: string | null;
  enableIdeIntegration?: boolean;
}

export interface Backend {
  label: string;
  binary: string;
  pathHints: string[];
  yoloFlag: string | null;
  resumeFlag: string | null;
  resumeIsSubcommand: boolean;
}

export interface WsClient {
  socket: import("net").Socket;
  buffer: Buffer;
  fragments: Buffer[];
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  totalLength: number;
}

export interface SelectionParams {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

export interface McpMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
}
