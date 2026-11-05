#!/usr/bin/env bun
/**
 * MCP entry point used by the project's .mcp.json and .codex/config.toml.
 * Installs dependencies on a fresh clone first, keeping stdout clean for stdio.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
if (!existsSync(join(root, "node_modules", "@modelcontextprotocol"))) {
  const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  process.stderr.write(install.stdout);
  process.stderr.write(install.stderr);
  if (install.exitCode !== 0) {
    console.error(JSON.stringify({ event: "mcp.error", message: "bun install failed; run `bun run setup` in the project folder" }));
    process.exit(1);
  }
}
const { runMcpServer } = await import("../packages/mcp-server/src/run.js");
await runMcpServer();
