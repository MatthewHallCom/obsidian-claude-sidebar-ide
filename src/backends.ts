import type { Backend } from "./types";

export const CLI_BACKENDS: Record<string, Backend> = {
  claude: {
    label: "Claude Code",
    binary: "claude",
    pathHints: ["~/.local/bin"],
    yoloFlag: "--dangerously-skip-permissions",
    resumeFlag: "--continue",
    resumeIsSubcommand: false,
  },
  codex: {
    label: "Codex",
    binary: "codex",
    pathHints: [],
    yoloFlag: "--yolo",
    resumeFlag: "resume --last",
    resumeIsSubcommand: true,
  },
  opencode: {
    label: "OpenCode",
    binary: "opencode",
    pathHints: ["/opt/homebrew/bin"],
    yoloFlag: null,
    resumeFlag: "--continue",
    resumeIsSubcommand: false,
  },
  gemini: {
    label: "Gemini CLI",
    binary: "gemini",
    pathHints: [],
    yoloFlag: "--approval-mode=yolo",
    resumeFlag: "--resume",
    resumeIsSubcommand: false,
  },
};

export type BackendKey = keyof typeof CLI_BACKENDS;
