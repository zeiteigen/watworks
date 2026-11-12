#!/usr/bin/env bun
/**
 * One-shot setup for a source checkout: dependencies and the unpacked extension build.
 * Safe to re-run. `--update` (used by `bun run update`) ends with reload instructions
 * instead of first-run instructions.
 * Only node: builtins are imported statically because dependencies may be missing.
 */
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));

function step(message: string) { console.log(`\n==> ${message}`); }

function run(cmd: string[], cwd = root) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${cmd.join(" ")}`);
}

async function main() {
  step("Installing dependencies");
  run(["bun", "install", "--frozen-lockfile"]);

  step("Building the browser extension");
  run(["bun", "packages/extension/build.ts"]);

  const extension = join(root, "dist", "packages", "extension");
  if (args.has("--update")) {
    const { version } = await Bun.file(join(extension, "manifest.json")).json() as { version: string };
    console.log(`
Update complete. The extension (version ${version}) was rebuilt in:
  ${extension}

To start using it:
  1. Wait until no application is uploading or submitting in the workspace.
  2. Open chrome://extensions and click the reload button on "WaterlooWorks Workspace".
     Reloading a WaterlooWorks tab does not update the extension.
`);
    return;
  }
  console.log(`
Setup complete.

Load the extension (one time):
  1. Open chrome://extensions (or your Chromium browser's equivalent)
  2. Enable Developer mode, click "Load unpacked", and select:
       ${extension}
  3. Sign in to WaterlooWorks, then open the extension popup and select Open dashboard.
`);
}

main().catch((error: unknown) => {
  console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
