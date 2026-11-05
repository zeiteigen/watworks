import { join } from "node:path";
import assert from "node:assert/strict";
import { DEFAULT_BRIDGE_BASE_URL, DEFAULT_BRIDGE_PORT, LOOPBACK_BRIDGE_HOST } from "../packages/shared/src/protocol.js";
import { probeBridge } from "../packages/bridge/src/probe.js";
import { createSmokeClient, withTimeout } from "./mcp-smoke-client.js";
export { withTimeout } from "./mcp-smoke-client.js";

/** Exercise compiled stdio clients. Shared mode only reads an existing bridge. */
export async function smokeMcp(executable: string, cwd: string, options: { shared?: boolean } = {}): Promise<void> {
  if (options.shared) await probeBridge(DEFAULT_BRIDGE_BASE_URL, AbortSignal.timeout(1_000));
  // Reuse a test-owned workspace probe so bridge lifecycle assertions remain
  // isolated and verification never leaves a detached workspace process behind.
  const dataDir = join(cwd, "smoke-workspace");
  const workspace = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ app: "wat-dashboard", dataDir }),
  });
  const clients: ReturnType<typeof createSmokeClient>[] = [];
  const start = async () => {
    const client = createSmokeClient(executable, cwd, { WAT_DATA_DIR: dataDir, WAT_DASHBOARD_PORT: String(workspace.port) });
    clients.push(client);
    await client.initialize();
    return client;
  };
  const health = async () => {
    const response = await fetch(`${DEFAULT_BRIDGE_BASE_URL}/health`);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const owner = await start();
    assert.ok(owner.stderr.includes(options.shared ? '"event":"bridge.reused"' : '"event":"bridge.listening"'));
    const follower = await start();
    assert.ok(follower.stderr.includes('"event":"bridge.reused"'));
    await follower.end();
    assert.ok(!follower.stderr.includes('"event":"bridge.closed"'));
    await probeBridge(DEFAULT_BRIDGE_BASE_URL, AbortSignal.timeout(1_000));
    await owner.checkTools();

    if (options.shared) {
      await owner.end();
      assert.ok(!owner.stderr.includes('"event":"bridge.closed"'));
      await probeBridge(DEFAULT_BRIDGE_BASE_URL, AbortSignal.timeout(1_000));
      return;
    }

    assert.deepEqual(await health(), { service: "waterlooworks-extension-bridge", bridgeConnected: false });
    const successor = await start();
    await owner.end();
    assert.ok(owner.stderr.includes('"event":"bridge.closed"'));
    await withTimeout((async () => {
      while (!successor.stderr.includes('"event":"bridge.listening"')) await Bun.sleep(20);
    })(), "bridge takeover");
    await successor.checkTools();
    assert.deepEqual(await health(), { service: "waterlooworks-extension-bridge", bridgeConnected: false });
    assert.equal((await fetch(`${DEFAULT_BRIDGE_BASE_URL}/session`, { method: "POST" })).status, 404);
    await successor.end();
    const probe = Bun.serve({ hostname: LOOPBACK_BRIDGE_HOST, port: DEFAULT_BRIDGE_PORT, fetch: () => new Response("probe") });
    await probe.stop(true);
  } finally {
    // Close followers before owners to avoid triggering needless takeovers.
    try { for (const client of clients.reverse()) await client.cleanup(); }
    finally { await workspace.stop(true); }
  }
}
