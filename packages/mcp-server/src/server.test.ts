import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWaterlooWorksMcpServer } from "./index.js";
import { WaterlooWorksClient } from "../../waterlooworks-client/src/client.js";
import { createStaticSession } from "../../waterlooworks-client/src/session.js";

describe("WaterlooWorks MCP adapter", () => {
  test("exposes semantic tools and strips raw protocol data from results", async () => {
    const fakeClient = {
      health: async () => ({ authenticated: true, bridgeConnected: true, bootstrapped: true }),
      searchJobs: async () => ({
        items: [
          {
            id: "12345",
            title: "FPGA Design Co-op",
            organization: "Example Semiconductors",
            raw: { cookie: "fake-cookie-value", action: "fake-action-value" },
          },
        ],
        total: 1,
        page: 1,
        raw: { cookie: "fake-cookie-value" },
      }),
      getJob: async () => ({
        id: "12345",
        title: "FPGA Design Co-op",
        raw: { cookie: "fake-cookie-value", action: "fake-action-value" },
      }),
    } as unknown as WaterlooWorksClient;

    const server = createWaterlooWorksMcpServer({ client: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(client.getInstructions()).toContain("Recommended research workflow");
    expect(client.getInstructions()).toContain("waterlooworks_get_employer_report");
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "waterlooworks_status",
      "waterlooworks_search_jobs",
      "waterlooworks_get_search_metadata",
      "waterlooworks_get_job",
      "waterlooworks_get_account_overview",
      "waterlooworks_get_document_metadata",
      "waterlooworks_get_employer_report",
      "waterlooworks_list_applications",
      "waterlooworks_list_documents",
      "waterlooworks_upload_document",
      "waterlooworks_set_default_documents",
      "waterlooworks_get_application_form",
      "waterlooworks_prepare_application",
      "waterlooworks_submit_application",
      "waterlooworks_get_application_status",
      "waterlooworks_get_operation_status",
      "discovery_policy_get",
      "discovery_policy_save",
      "discoveries_list",
      "workspace_status",
      "profile_get",
      "profile_save",
      "experience_save",
      "resume_save_variant",
      "resume_list",
      "jobs_search",
      "job_save",
      "job_skip",
      "cover_letter_save",
      "job_document_save",
      "job_documents",
      "application_plan_save",
      "jobs_list",
      "dashboard_open",
    ]);
    const searchTool = tools.tools.find((tool) => tool.name === "waterlooworks_search_jobs");
    const searchProperties = (searchTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(searchProperties).not.toHaveProperty("page");
    expect(searchProperties).not.toHaveProperty("itemsPerPage");

    const result = await client.callTool({
      name: "waterlooworks_search_jobs",
      arguments: { keyword: "FPGA" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("FPGA Design Co-op");
    expect(serialized).not.toContain('"page"');
    expect(serialized).not.toContain("fake-cookie-value");
    expect(serialized).not.toContain("fake-action-value");

    await client.close();
    await server.close();
  });

  test("composes the real client and MCP search tool over offline fixtures", async () => {
    const fixtureRoot = new URL("../../waterlooworks-client/test/fixtures/", import.meta.url);
    const page = await Bun.file(new URL("jobs-page.html", fixtureRoot)).text();
    const searchResponse = await Bun.file(new URL("search-keyword.json", fixtureRoot)).text();
    const realClient = new WaterlooWorksClient(
      { getSession: async () => createStaticSession([]) },
      {
        fetchImpl: async (input, init) => {
          const url = String(input);
          return {
            status: 200,
            ok: true,
            url,
            text: async () => (!init?.method || init.method === "GET" ? page : searchResponse),
          } as Response;
        },
      },
    );

    const server = createWaterlooWorksMcpServer({ client: realClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "integration-test-client", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "waterlooworks_search_jobs",
      arguments: { keyword: "FPGA" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("FPGA Design Co-op");
    expect(serialized).not.toContain('"raw"');

    await client.close();
    await server.close();
  });
});
