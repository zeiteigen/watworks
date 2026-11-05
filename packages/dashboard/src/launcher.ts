import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { installRoot } from "../../workspace/src/paths.js";
import type { Workspace } from "../../workspace/src/store.js";

export const DASHBOARD_PORT = Number(process.env.WAT_DASHBOARD_PORT ?? 39452);
export const DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_PORT}`;

/** Resolve to the running dashboard's data directory, or undefined if none answers. */
export async function probeDashboard(timeoutMs = 500): Promise<string | undefined> {
  try {
    const response = await fetch(`${DASHBOARD_ORIGIN}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json() as { app?: unknown; dataDir?: unknown };
    return body.app === "wat-dashboard" && typeof body.dataDir === "string" ? body.dataDir : undefined;
  } catch {
    return undefined;
  }
}

/** Start the dashboard as a detached process that outlives the agent session, then return its link. */
export async function ensureDashboard(workspace: Workspace): Promise<string> {
  let running = await probeDashboard();
  if (running === undefined) {
    const args = Bun.isStandaloneExecutable ? ["--dashboard"] : [join(installRoot(), "packages", "mcp-server", "src", "cli.ts"), "--dashboard"];
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env, cwd: installRoot() });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (running === undefined && Date.now() < deadline) {
      await Bun.sleep(200);
      running = await probeDashboard();
    }
    if (running === undefined) throw new Error(`The dashboard did not start. Run \`bun run dashboard\` to see why.`);
  }
  if (running !== workspace.paths.root) throw new Error(`Another dashboard is already serving ${running} on port ${DASHBOARD_PORT}. Stop it, or set WAT_DASHBOARD_PORT.`);
  return `chrome-extension://${EXPECTED_EXTENSION_ID}/dashboard.html`;
}
