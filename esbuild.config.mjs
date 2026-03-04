import esbuild from "esbuild";
import builtinModules from "builtin-modules";
import { readFileSync } from "fs";

const prod = process.argv.includes("--prod");

// Read Python PTY scripts and base64-encode them at build time
const ptyB64 = readFileSync("src/terminal_pty.py").toString("base64");
const winPtyB64 = readFileSync("src/terminal_win.py").toString("base64");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2021",
  outfile: "main.js",
  platform: "node",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  define: {
    __PTY_SCRIPT_B64__: JSON.stringify(ptyB64),
    __WIN_PTY_SCRIPT_B64__: JSON.stringify(winPtyB64),
  },
});

if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
