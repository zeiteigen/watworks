import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpConfig } from "./config.js";
import { VERSION } from "../../shared/src/version.js";

async function runCli(...args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], {
    cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("MCP command-line setup", () => {
  test("source configuration works outside the project working directory", async () => {
    const result = await runCli("--print-config");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(createMcpConfig(process.execPath, [join(import.meta.dir, "cli.ts")]));
  });

  test("configuration JSON round-trips Windows paths containing spaces", () => {
    const command = "C:\\Users\\Student Name\\WaterlooWorks MCP\\waterlooworks-mcp.exe";
    expect(JSON.parse(JSON.stringify(createMcpConfig(command))).mcpServers.waterlooworks).toEqual({ command, args: [] });
  });

  test("informational commands do not start the bridge", async () => {
    const version = await runCli("--version");
    expect(version).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    const help = await runCli("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--print-config");
    expect(help.stderr).toBe("");
  });

  test("invalid options fail on stderr without protocol output", async () => {
    for (const args of [["--unknown"], ["--version", "--help"]]) {
      const result = await runCli(...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--help");
      expect(result.stderr).not.toContain("bridge.listening");
    }
  });
});
