import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWaterlooWorksMcpServer } from "./index.js";
import { findLatexEngine } from "../../workspace/src/latex/compile.js";
import { Workspace } from "../../workspace/src/store.js";
import type { WaterlooWorksClient } from "../../waterlooworks-client/src/client.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function connect() {
  const root = await mkdtemp(join(tmpdir(), "wat-tools-test-"));
  roots.push(root);
  const opened: string[] = [];
  const server = createWaterlooWorksMcpServer({
    client: {} as WaterlooWorksClient,
    workspace: new Workspace(root),
    openFile: path => { opened.push(path); return true; },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
  };
  return { call, opened };
}

describe.skipIf(!findLatexEngine())("document tools", () => {
  test("open a newly created PDF once, not on later revisions", async () => {
    const { call, opened } = await connect();
    const args = { variant: "swe", label: "Software", resume: { heading: { name: "Jane" }, sections: [{ kind: "list", title: "Skills", items: ["TypeScript"] }] } };
    const first = await call("resume_save_variant", args);
    expect(first.opened).toBe(true);
    expect(opened).toEqual([first.pdf as string]);
    expect((await call("resume_save_variant", args)).opened).toBe(false);
    expect(opened).toHaveLength(1);
  }, 300_000);
});

describe("work authorization guidance", () => {
  test("is part of the server instructions", async () => {
    const server = createWaterlooWorksMcpServer({ client: {} as WaterlooWorksClient, openFile: () => false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(client.getInstructions()).toContain("Work authorization for Canadian citizens");
  });
});
