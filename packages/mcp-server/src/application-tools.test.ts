import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import type { ApplicationGateway } from "../../application-workflow/src/types.js";
import type { WaterlooWorksClient } from "../../waterlooworks-client/src/client.js";
import { createWaterlooWorksMcpServer } from "./index.js";

test("MCP prepares applications but exposes no write tool or approval capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "application-mcp-test-"));
  let writes = 0;
  const account = { accountKey: "a".repeat(64), accountLabel: "Synthetic student" };
  const gateway: ApplicationGateway = {
    capabilities: { submit: true, upload: true, defaults: true },
    getAccount: async () => account,
    getApplicationForm: async jobId => ({ ...account, jobId, title: "Developer", employer: "Example", term: "Winter 2027", deadline: "2099-01-01T00:00:00Z", version: "v1", canApply: true, hasApplication: false, blockers: [], externalSteps: [],
      requirements: [{ id: "resume", typeId: "1", label: "Resume", required: true, role: "resume" }], questions: [{ id: "authorized", label: "Authorized?", type: "single_choice", required: true, options: [{ id: "yes", label: "Yes" }] }] }),
    listDocuments: async () => [{ id: "101", typeId: "1", name: "Resume", revision: "b".repeat(64), state: "ready", source: "library" }],
    getApplicationStatus: async jobId => ({ jobId, hasApplication: false }),
    uploadDocument: async () => { writes++; throw new Error("Unexpected upload"); },
    setDefaultDocuments: async () => { writes++; throw new Error("Unexpected default change"); },
    submitApplication: async () => { writes++; throw new Error("Unexpected submission"); },
  };
  const applications = new ApplicationWorkflow({ gateway, documentRoots: [], ledgerPath: join(root, "state", "attempts.sqlite") });
  const server = createWaterlooWorksMcpServer({ applications, client: {} as WaterlooWorksClient });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-application-test", version: "1" });
  try {
    await server.connect(b); await client.connect(a);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names.filter(name => /approve|confirm|submit|upload|set_default/.test(name))).toEqual([]);
    const invalid = await client.callTool({ name: "waterlooworks_prepare_application", arguments: { jobId: "123", resumeDocumentId: "101", answers: [] } });
    expect((invalid.structuredContent as Record<string, unknown>)?.status).toBe("blocked");
    const prepared = await client.callTool({ name: "waterlooworks_prepare_application", arguments: { jobId: "123", resumeDocumentId: "101", answers: [{ questionId: "authorized", value: "yes" }] } });
    expect((prepared.structuredContent as Record<string, unknown>)?.status).toBe("prepared");
    expect(JSON.stringify(prepared)).not.toMatch(/reviewUrl|token|127\.0\.0\.1/);
    expect(client.getInstructions()).toContain("Agents have no write tools");
    expect(client.getInstructions()).not.toContain("reviewUrl");
    expect(writes).toBe(0);
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});
