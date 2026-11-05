#!/usr/bin/env bun
/**
 * One-shot local setup for a source checkout: dependencies, extension build,
 * Tectonic, the data/ workspace, and agent skill links. Safe to re-run.
 * Only node: builtins are imported statically because dependencies may be missing.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const TECTONIC_VERSION = "0.17.0";

function step(message: string) { console.log(`\n==> ${message}`); }

function run(cmd: string[], cwd = root) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${cmd.join(" ")}`);
}

function tectonicAsset(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  const target = process.platform === "linux" && arch ? `${arch}-unknown-linux-musl.tar.gz`
    : process.platform === "darwin" && arch ? `${arch}-apple-darwin.tar.gz`
      : process.platform === "win32" && arch === "x86_64" ? "x86_64-pc-windows-msvc.zip" : undefined;
  if (!target) throw new Error(`No Tectonic build for ${process.platform}/${process.arch}; install a LaTeX distribution with pdflatex instead.`);
  return `tectonic-${TECTONIC_VERSION}-${target}`;
}

async function installTectonic() {
  const { findLatexEngine, compileLatex } = await import("../packages/workspace/src/latex/compile.js");
  let engine = findLatexEngine();
  if (engine?.name !== "tectonic") {
    const asset = tectonicAsset();
    const dir = join(root, ".tools", "tectonic");
    mkdirSync(dir, { recursive: true });
    const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${asset}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Tectonic download failed: HTTP ${response.status}`);
    const archive = join(dir, asset);
    await Bun.write(archive, response);
    // bsdtar on Windows 10+ also extracts .zip archives.
    run(["tar", "-xf", archive, "-C", dir]);
    rmSync(archive);
    engine = findLatexEngine();
    if (engine?.name !== "tectonic") throw new Error("Tectonic was downloaded but could not be found");
  }
  console.log(`Using ${engine.name} at ${engine.path}`);
  console.log("Warming the LaTeX package cache (the first run downloads packages)...");
  const template = await Bun.file(join(root, "templates", "resume", "jake.tex")).text();
  await compileLatex(template.replace("%%WAT:BODY%%", "\\resumeHeading{Setup}{check}"));
  console.log("LaTeX is ready.");
}

/** Claude Code reads .claude/skills; Codex reads .agents/skills. Keep one source of truth. */
function linkSkills() {
  const target = join(root, ".claude", "skills");
  const source = join(root, ".agents", "skills");
  const resolves = existsSync(target) && statSync(target).isDirectory() && readdirSync(target).length > 0;
  if (resolves) return console.log(".claude/skills is linked.");
  mkdirSync(join(root, ".claude"), { recursive: true });
  if (existsSync(target) || isDanglingLink(target)) rmSync(target, { recursive: true, force: true });
  try {
    symlinkSync(join("..", ".agents", "skills"), target, "junction");
    console.log("Linked .claude/skills -> .agents/skills");
  } catch {
    cpSync(source, target, { recursive: true });
    console.log("Copied .agents/skills to .claude/skills (symlinks unavailable; re-run setup after updating skills).");
  }
}

function isDanglingLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

async function main() {
  step("Installing dependencies");
  run(["bun", "install", "--frozen-lockfile"]);

  step("Building the browser extension");
  run(["bun", "packages/extension/build.ts"]);

  if (!args.has("--skip-latex")) {
    step("Setting up LaTeX (Tectonic)");
    await installTectonic();
  }

  step("Creating the data/ workspace");
  const { Workspace } = await import("../packages/workspace/src/store.js");
  const workspace = new Workspace();
  await workspace.scaffold();
  console.log(`Workspace: ${workspace.paths.root}`);

  step("Enabling extension service startup");
  const { installNativeHost } = await import("../packages/native-host/src/install.js");
  await installNativeHost();

  step("Linking agent skills");
  linkSkills();

  console.log(`
Setup complete.

Next, connect your browser session (one time):
  1. Open chrome://extensions (or your Chromium browser's equivalent)
  2. Enable Developer mode, click "Load unpacked", and select:
       ${join(root, "dist", "packages", "extension")}
  3. Open the extension popup and select Sign In. Complete any autofill or Duo prompts.
     Open Dashboard opens inside the extension. The agent starts workspace file access automatically.

Then, in Claude Code or Codex from this folder:
  /onboard      (Codex: $onboard)
  /job-search   (Codex: $job-search)
`);
}

main().catch((error: unknown) => {
  console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
