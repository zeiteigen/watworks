import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import type { ApplicationGateway } from "../../application-workflow/src/types.js";
import type { WaterlooWorksClient } from "../../waterlooworks-client/src/client.js";
import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import { createWaterlooWorksMcpServer } from "./index.js";

test("MCP preparation and submission require an independent localhost decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "application-mcp-test-"));
  let writes = 0;
  const account = { accountKey: "a".repeat(64), accountLabel: "Synthetic student" };
  const gateway: ApplicationGateway = {
    capabilities: { submit: true, upload: true, defaults: true },
    getAccount: async () => account,
    getApplicationForm: async jobId => ({ ...account, jobId, title: "Developer", employer: "Example", term: "Winter 2027", deadline: "2099-01-01T00:00:00Z", version: "v1", canApply: true, hasApplication: false, blockers: [], externalSteps: [], requirements: [{ id: "1", typeId: "1", label: "Resume", required: true, role: "resume" }], questions: [{ id: "authorized", label: "Authorized?", type: "single_choice", required: true, options: [{ id: "yes", label: "Yes" }] }] }),
    listDocuments: async () => [{ id: "101", typeId: "1", name: "Resume", revision: "b".repeat(64), state: "ready", source: "library" }],
    getApplicationStatus: async jobId => ({ jobId, hasApplication: writes > 0 }),
    uploadDocument: async () => { throw new Error("Unexpected upload"); },
    setDefaultDocuments: async () => { throw new Error("Unexpected default change"); },
    submitApplication: async (manifest, _files, beforeFinalSubmit) => {
      beforeFinalSubmit(); writes++;
      return { applicationId: "42", jobId: manifest.jobId, status: "submitted", manifestHash: fingerprint(manifest), externalSteps: [] };
    },
  };
  const applications = new ApplicationWorkflow({ gateway, documentRoots: [], ledgerPath: join(root, "state", "attempts.sqlite") });
  const server = createWaterlooWorksMcpServer({ applications, client: {} as WaterlooWorksClient });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-application-test", version: "1" });
  try {
    await server.connect(b); await client.connect(a);
    const tools = (await client.listTools()).tools;
    expect(tools.some(tool => /approve|confirm/.test(tool.name))).toBe(false);
    const submit = tools.find(tool => tool.name === "waterlooworks_submit_application")!;
    expect(Object.keys(submit.inputSchema.properties ?? {})).toEqual(["draftId"]);
    const invalid = await client.callTool({ name: "waterlooworks_prepare_application", arguments: { jobId: "123", resumeDocumentId: "101", answers: [] } });
    expect((invalid.structuredContent as Record<string, unknown>)?.status).toBe("blocked");
    const prepared = await client.callTool({ name: "waterlooworks_prepare_application", arguments: { jobId: "123", resumeDocumentId: "101", answers: [{ questionId: "authorized", value: "yes" }] } });
    expect((prepared.structuredContent as Record<string, unknown>)?.status).toBe("prepared");
    const reviewResult = await client.callTool({ name: "waterlooworks_submit_application", arguments: { draftId: (prepared.structuredContent as Record<string, unknown>).draftId } });
    const review = reviewResult.structuredContent as Record<string, unknown>;
    expect(review.status).toBe("awaiting_approval");
    expect(writes).toBe(0);
    // Only this synthetic fake gateway is approved in the test. No WaterlooWorks requests occur.
    const url = new URL(review.reviewUrl as string);
    const endpoint = `${url.origin}/api/reviews/${review.operationId}`;
    const headers = { authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`, origin: url.origin, "content-type": "application/json" };
    const snapshot = await (await fetch(endpoint, { headers })).json() as { manifestHash: string; nonce: string };
    expect((await fetch(`${endpoint}/approve`, { method: "POST", headers, body: JSON.stringify({ manifestHash: snapshot.manifestHash, nonce: snapshot.nonce }) })).status).toBe(202);
    for (let i = 0; i < 100 && applications.getOperationStatus(review.operationId as string).status === "executing"; i++) await Bun.sleep(5);
    const status = await client.callTool({ name: "waterlooworks_get_operation_status", arguments: { operationId: review.operationId } });
    expect((status.structuredContent as Record<string, unknown>)?.status).toBe("succeeded");
    expect(writes).toBe(1);
    expect((await fetch(`${endpoint}/approve`, { method: "POST", headers, body: JSON.stringify({ manifestHash: snapshot.manifestHash, nonce: snapshot.nonce }) })).status).toBe(409);
    expect(writes).toBe(1);
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});
