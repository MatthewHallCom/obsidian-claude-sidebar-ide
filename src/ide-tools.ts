import { App, TFile, MarkdownView } from "obsidian";
import type { SelectionParams, McpTool, McpToolResult } from "./types";

export interface IdeToolContext {
  app: App;
  getVaultPath: () => string;
  showDiff: (filePath: string, oldContent: string, newContent: string) => Promise<"FILE_SAVED" | "DIFF_REJECTED">;
  getLastSelection: () => SelectionParams | null;
  pendingDiffPromises: Map<number, (result: string) => void>;
}

export class ToolError extends Error {
  constructor(message: string, public code = -32000) {
    super(message);
    this.name = "ToolError";
  }
}

export function getToolCatalog(): McpTool[] {
  return [
    {
      name: "getCurrentSelection",
      description: "Get the current text selection in the active editor",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "getLatestSelection",
      description: "Get the most recent text selection (even if editor lost focus)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "getOpenEditors",
      description: "Get list of open editor tabs",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "getWorkspaceFolders",
      description: "Get the workspace folder paths",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "getDiagnostics",
      description: "Get diagnostics for a file",
      inputSchema: { type: "object", properties: { uri: { type: "string" } } }
    },
    {
      name: "checkDocumentDirty",
      description: "Check if a document has unsaved changes",
      inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] }
    },
    {
      name: "openFile",
      description: "Open a file in the editor",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "number" },
          preview: { type: "boolean" }
        },
        required: ["filePath"]
      }
    },
    {
      name: "openDiff",
      description: "Show a diff between old and new content",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldContent: { type: "string" },
          newContent: { type: "string" }
        },
        required: ["filePath", "oldContent", "newContent"]
      }
    },
    {
      name: "saveDocument",
      description: "Save a document",
      inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] }
    },
    {
      name: "close_tab",
      description: "Close an editor tab",
      inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] }
    },
    {
      name: "closeAllDiffTabs",
      description: "Close all diff views",
      inputSchema: { type: "object", properties: {} }
    },
  ];
}

function makeResult(data: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }]
  };
}

// Get the editor from the most recent markdown leaf (works even when sidebar has focus)
function getEditorFromRecentLeaf(app: App): { editor: MarkdownView["editor"] | null; file: TFile | null } {
  // Try activeEditor first (works when editor has focus)
  const activeEditor = app.workspace.activeEditor?.editor;
  const activeFile = app.workspace.getActiveFile();
  if (activeEditor && activeFile) return { editor: activeEditor, file: activeFile };

  // Fall back to getMostRecentLeaf (works when sidebar has focus)
  const leaf = app.workspace.getMostRecentLeaf();
  if (leaf?.view instanceof MarkdownView) {
    return { editor: leaf.view.editor, file: leaf.view.file };
  }
  return { editor: null, file: null };
}

export async function handleToolCall(
  ctx: IdeToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpToolResult> {
  const vaultPath = ctx.getVaultPath();

  switch (toolName) {
    case "getCurrentSelection": {
      const { editor, file } = getEditorFromRecentLeaf(ctx.app);
      if (!editor || !file) {
        const lastSelection = ctx.getLastSelection();
        if (lastSelection) return makeResult(lastSelection);
        return makeResult({
          text: "",
          filePath: "",
          selection: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
            isEmpty: true
          }
        });
      }
      const sel = editor.getSelection();
      if (!sel) {
        const lastSelection = ctx.getLastSelection();
        if (lastSelection) return makeResult(lastSelection);
      }
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      return makeResult({
        text: sel || "",
        filePath: `${vaultPath}/${file.path}`,
        selection: {
          start: { line: from.line, character: from.ch },
          end: { line: to.line, character: to.ch },
          isEmpty: !sel
        }
      });
    }

    case "getLatestSelection": {
      const lastSelection = ctx.getLastSelection();
      if (lastSelection) {
        return makeResult(lastSelection);
      }
      const { editor, file } = getEditorFromRecentLeaf(ctx.app);
      if (!editor || !file) {
        return makeResult({
          text: "",
          filePath: "",
          selection: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
            isEmpty: true
          }
        });
      }
      const sel = editor.getSelection();
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      return makeResult({
        text: sel || "",
        filePath: `${vaultPath}/${file.path}`,
        selection: {
          start: { line: from.line, character: from.ch },
          end: { line: to.line, character: to.ch },
          isEmpty: !sel
        }
      });
    }

    case "getOpenEditors": {
      const leaves = ctx.app.workspace.getLeavesOfType("markdown");
      const activeFile = ctx.app.workspace.getActiveFile();
      const editors = leaves.map(leaf => {
        const f = (leaf.view as { file?: TFile })?.file;
        if (!f) return null;
        return {
          uri: `${vaultPath}/${f.path}`,
          isActive: !!(activeFile && f.path === activeFile.path),
          label: f.basename,
          languageId: "markdown",
          isDirty: false
        };
      }).filter(Boolean);
      return makeResult(editors);
    }

    case "getWorkspaceFolders": {
      return makeResult([{ uri: vaultPath, name: ctx.app.vault.getName() }]);
    }

    case "getDiagnostics": {
      return makeResult([]);
    }

    case "checkDocumentDirty": {
      return makeResult({ isDirty: false });
    }

    case "openFile": {
      const filePath = (args.filePath as string) || "";
      const relativePath = filePath.startsWith(vaultPath)
        ? filePath.slice(vaultPath.length + 1)
        : filePath;
      try {
        await ctx.app.workspace.openLinkText(relativePath, "", false);
        if (args.line != null) {
          const editor = ctx.app.workspace.activeEditor?.editor;
          if (editor) {
            const line = Math.max(0, (args.line as number) - 1);
            editor.setCursor({ line, ch: 0 });
            editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
          }
        }
        return makeResult({ success: true });
      } catch (err) {
        throw new ToolError(`Failed to open file: ${(err as Error).message}`);
      }
    }

    case "openDiff": {
      const result = await ctx.showDiff(
        args.filePath as string,
        args.oldContent as string,
        args.newContent as string
      );
      return makeResult({ result });
    }

    case "saveDocument": {
      const uri = (args.uri as string) || "";
      const relPath = uri.startsWith(vaultPath) ? uri.slice(vaultPath.length + 1) : uri;
      const abstractFile = ctx.app.vault.getAbstractFileByPath(relPath);
      if (abstractFile && abstractFile instanceof TFile) {
        return makeResult({ success: true });
      } else {
        throw new ToolError(`File not found: ${relPath}`);
      }
    }

    case "close_tab": {
      const fp = (args.filePath as string) || "";
      const relPath = fp.startsWith(vaultPath) ? fp.slice(vaultPath.length + 1) : fp;
      const leaves = ctx.app.workspace.getLeavesOfType("markdown");
      for (const leaf of leaves) {
        if ((leaf.view as { file?: TFile })?.file?.path === relPath) {
          leaf.detach();
          return makeResult({ success: true });
        }
      }
      return makeResult({ success: false, error: "Tab not found" });
    }

    case "closeAllDiffTabs": {
      for (const [, resolver] of ctx.pendingDiffPromises) {
        resolver("DIFF_REJECTED");
      }
      ctx.pendingDiffPromises.clear();
      return makeResult({ success: true });
    }

    default:
      throw new ToolError(`Unknown tool: ${toolName}`, -32601);
  }
}
