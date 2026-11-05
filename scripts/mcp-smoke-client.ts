import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../packages/shared/src/version.js";

export async function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out`)), 10_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** A test-owned subprocess. Cleanup never targets pre-existing MCP processes. */
export function createSmokeClient(executable: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(executable, [], { cwd, env: { ...process.env, ...env, PATH: "" }, stdio: "pipe" });
  let stderr = "";
  let protocolError: unknown;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited before responding: ${stderr}`));
      pending.clear();
      resolve(code);
    });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0", "stdout must contain only JSON-RPC messages");
      const waiter = pending.get(message.id);
      if (waiter) {
        assert.equal(message.error, undefined);
        pending.delete(message.id);
        waiter.resolve(message.result);
      }
    } catch (error) {
      protocolError = error;
      for (const waiter of pending.values()) waiter.reject(error);
    }
  });
  let nextId = 1;
  async function request<T>(method: string, params?: unknown): Promise<T> {
    if (protocolError) throw protocolError;
    const id = nextId++;
    const response = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    try {
      return await withTimeout(response, method) as T;
    } finally {
      pending.delete(id);
    }
  }
  return {
    request,
    get stderr() { return stderr; },
    async initialize() {
      const result = await request<InitializeResult>("initialize", {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-smoke", version: "1" },
      });
      assert.deepEqual(result.serverInfo, { name: "waterlooworks-mcp", version: VERSION });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      await this.checkTools();
    },
    async checkTools() {
      const tools = await request<ListToolsResult>("tools/list");
      assert.deepEqual(tools.tools.map((tool) => tool.name), [
        "waterlooworks_status", "waterlooworks_search_jobs", "waterlooworks_get_search_metadata",
        "waterlooworks_get_job", "waterlooworks_get_account_overview", "waterlooworks_get_document_metadata",
        "waterlooworks_get_employer_report",
        "waterlooworks_list_documents",
        "waterlooworks_upload_document",
        "waterlooworks_set_default_documents",
        "waterlooworks_get_application_form",
        "waterlooworks_prepare_application",
        "waterlooworks_submit_application",
        "waterlooworks_get_application_status",
        "waterlooworks_get_operation_status",
      ]);
    },
    async end() {
      child.stdin.end();
      assert.equal(await withTimeout(closed, "EOF shutdown"), 0, stderr);
      assert.equal(protocolError, undefined);
    },
    async cleanup() {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await withTimeout(closed, "process cleanup");
    },
  };
}
