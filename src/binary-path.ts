import * as os from "os";

/** Expand a leading ~ or ~/ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return os.homedir() + p.slice(1);
  return p;
}

/**
 * Quote an arbitrary string for safe embedding in a POSIX `sh -c` command line.
 * Total function — single quotes make the content fully literal; an embedded
 * single quote is closed, escaped as \', and reopened ('\'').
 */
export function posixQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Quote a string for a Windows cmd.exe command line, or return null if it
 * cannot be embedded safely. Inside cmd.exe double quotes, `& | < > ^` are
 * already literal, but `"` breaks quoting and `%`/`!` still trigger variable
 * expansion — so any value containing `"`, `%`, `!`, or a control character
 * is rejected rather than quoted.
 */
export function windowsQuote(s: string): string | null {
  if (/["%!]/.test(s) || /[\x00-\x1f]/.test(s)) return null;
  return `"${s}"`;
}

/**
 * Resolve a backend executable to a shell-ready command token.
 *  - No custom path     -> the default binary name (trusted constant, unquoted).
 *  - Custom path        -> tilde-expanded, then ALWAYS quoted for the platform.
 *  - Unsafe on Windows  -> falls back to the default binary, logs a warning.
 */
export function resolveBinaryToken(
  customPath: string | undefined | null,
  defaultBinary: string,
  isWindows: boolean,
): string {
  const raw = (customPath || "").trim();
  if (!raw) return defaultBinary;
  const expanded = expandHome(raw);
  if (isWindows) {
    const quoted = windowsQuote(expanded);
    if (quoted === null) {
      console.warn("[binary-path] custom path rejected — unsafe characters; using default");
      return defaultBinary;
    }
    return quoted;
  }
  return posixQuote(expanded);
}
