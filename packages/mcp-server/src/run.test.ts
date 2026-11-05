import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const matching of [true, false]) {
  test(`MCP automatically connects workspace file access; matching workspace=${matching}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wat-startup-"));
    let probes = 0;
    // Only this synthetic service is accessed. No real dashboard routes or approvals.
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      expect(new URL(request.url).pathname).toBe("/api/ping");
      probes++;
      return Response.json({ app: "wat-dashboard", dataDir: matching ? root : root + "-other" });
    } });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts")], {
      env: { ...process.env, WAT_DATA_DIR: root, WAT_DASHBOARD_PORT: String(service.port) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const logs = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "startup-test", version: "1" } } }) + "\n");
      const first = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(first.value)).result.serverInfo.name).toBe("waterlooworks-mcp");
      child.stdin.end();
      expect(await child.exited).toBe(0);
      const stderr = await logs;
      expect(probes).toBeGreaterThan(0);
      expect(stderr).toContain(matching ? '"event":"workspace.ready"' : '"event":"workspace.start_failed"');
      expect(stderr).toContain('"event":"mcp.ready"');
    } finally {
      child.kill();
      await child.exited;
      reader.releaseLock();
      await service.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
