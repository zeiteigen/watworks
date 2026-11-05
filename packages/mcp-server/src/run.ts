import { ensureDashboard } from "../../dashboard/src/launcher.js";
import { Workspace } from "../../workspace/src/store.js";
import { BridgeLifecycle } from "../../bridge/src/lifecycle.js";
import { BunStdioServerTransport } from "./bun-stdio.js";
import { createWaterlooWorksMcpServer } from "./index.js";

export async function runMcpServer(): Promise<void> {
  const bridge = new BridgeLifecycle();
  let server: ReturnType<typeof createWaterlooWorksMcpServer> | undefined;
  try {
    await bridge.start();
    const workspace = new Workspace();
    server = createWaterlooWorksMcpServer({ workspace });
    const transport = new BunStdioServerTransport();
    await server.connect(transport);
    // Start disk-backed dashboard access with the workspace, rather than waiting
    // for an agent to call dashboard_open. This process survives the MCP session.
    try {
      await ensureDashboard(workspace);
      console.error(JSON.stringify({ event: "workspace.ready" }));
    } catch (error) {
      console.error(JSON.stringify({ event: "workspace.start_failed", error: error instanceof Error ? error.message : String(error) }));
    }
    console.error(JSON.stringify({ event: "mcp.ready", transport: "stdio" }));
    await transport.waitForClose();
  } finally {
    try {
      await server?.close();
    } finally {
      await bridge.close();
    }
  }
}
