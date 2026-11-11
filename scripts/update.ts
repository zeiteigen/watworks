#!/usr/bin/env bun
/**
 * Updates a source checkout: fast-forwards to the latest published snapshot, then re-runs
 * setup in a fresh process (dependencies, extension build, native startup helper, data/
 * workspace, skill links) so steps added by the update itself also run.
 *
 *   bun run update                pull the latest version and rebuild
 *   bun run update -- --no-pull   rebuild the current checkout only
 *   bun run update -- --latex     also refresh the LaTeX (Tectonic) setup
 *
 * Personal files in data/ are gitignored and never touched. Local edits to tracked files
 * stop the update; it never resets, stashes or discards anything itself.
 * Only node: builtins are imported statically because dependencies may be missing or stale.
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export type GitResult = { code: number; stdout: string; stderr: string };
export type Git = (args: string[]) => GitResult;
export class UpdateError extends Error {}

const MAX_LISTED_COMMITS = 15;

function required(git: Git, args: string[], failure: string): string {
  const result = git(args);
  if (result.code !== 0) throw new UpdateError(`${failure}${result.stderr.trim() ? `\n\nGit said: ${result.stderr.trim()}` : ""}`);
  return result.stdout.trim();
}

/** Fast-forwards the current branch to its upstream, refusing anything that could lose work. */
export function pullLatest(git: Git): { from: string; to: string; commits: string[]; more: number } {
  if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true")
    throw new UpdateError("This folder is not a Git checkout, so it cannot update itself.\nClone it with: git clone https://github.com/zeiteigen/watworks.git");
  const branch = required(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], "This checkout is not on a branch. Switch back with: git switch main");
  required(git, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    `Branch ${branch} has no upstream to update from. Set one with: git branch --set-upstream-to=origin/main`);
  const changed = git(["status", "--porcelain", "--untracked-files=no"]).stdout.split("\n").map(line => line.trim()).filter(Boolean);
  if (changed.length) throw new UpdateError([
    "These tracked files have local changes, so the update stopped before changing anything:",
    ...changed.slice(0, 20).map(line => `  ${line}`),
    ...(changed.length > 20 ? [`  ...and ${changed.length - 20} more`] : []),
    "",
    "Save them with `git stash` (restore later with `git stash pop`), then run `bun run update` again.",
    "Your data/ folder is not tracked and is never affected.",
  ].join("\n"));
  const from = required(git, ["rev-parse", "HEAD"], "Could not read the current version.");
  required(git, ["fetch", "--quiet"], "Could not download the latest version. Check your internet connection and try again.");
  required(git, ["merge", "--ff-only", "--quiet", "@{upstream}"], [
    "Could not fast-forward to the latest version. Nothing was changed.",
    "Either this branch has commits that are not in the published version, or an untracked file",
    "would be overwritten. To keep your commits, rebase them yourself: git rebase @{upstream}",
  ].join("\n"));
  const to = required(git, ["rev-parse", "HEAD"], "Could not read the updated version.");
  if (from === to) return { from, to, commits: [], more: 0 };
  const all = git(["log", "--format=%h %s", `${from}..${to}`]).stdout.split("\n").filter(Boolean);
  return { from, to, commits: all.slice(0, MAX_LISTED_COMMITS), more: Math.max(0, all.length - MAX_LISTED_COMMITS) };
}

/** The dashboard service is detached and outlives agent sessions, so an update leaves it on old code. */
export async function runningDashboard(port = Number(process.env.WAT_DASHBOARD_PORT ?? 39452)): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(500) });
    const body = await response.json() as { app?: unknown };
    return body.app === "wat-dashboard" ? port : undefined;
  } catch {
    return undefined;
  }
}

export function dashboardStopHelp(port: number, platform = process.platform): string {
  const stop = platform === "win32"
    ? `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess   (PowerShell)`
    : `kill $(lsof -ti tcp:${port} -sTCP:LISTEN)`;
  return [
    `The workspace dashboard service on port ${port} is still running the previous code.`,
    "Once no application is uploading or submitting, stop it with:",
    `  ${stop}`,
    "It starts again on its own the next time Claude Code or Codex opens this folder.",
  ].join("\n");
}

function systemGit(args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter(arg => !["--no-pull", "--latex"].includes(arg));
  if (unknown.length) throw new UpdateError(`Unknown option ${unknown.join(", ")}. Use --no-pull and/or --latex.`);

  if (!args.has("--no-pull")) {
    console.log("==> Downloading the latest version");
    const pulled = pullLatest(systemGit);
    if (!pulled.commits.length) console.log("Already up to date. Rebuilding anyway.");
    else {
      console.log(`Updated ${pulled.from.slice(0, 7)} -> ${pulled.to.slice(0, 7)}:`);
      for (const commit of pulled.commits) console.log(`  ${commit}`);
      if (pulled.more) console.log(`  ...and ${pulled.more} more`);
    }
  }

  // A fresh process runs the setup script as it exists after the pull.
  const setup = Bun.spawnSync([process.execPath, "scripts/setup.ts", "--update", ...(args.has("--latex") ? ["--latex"] : [])],
    { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (setup.exitCode !== 0) throw new UpdateError("Rebuilding failed (see above). The previous extension build may be incomplete; fix the error and run `bun run update -- --no-pull`.");

  const port = await runningDashboard();
  if (port !== undefined) console.log(`\n${dashboardStopHelp(port)}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`\nUpdate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
