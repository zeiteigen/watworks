import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ExtensionResearchClient } from "../../bridge/src/extension-proxy.js";
import { registerDiscoveryTools } from "./discovery-tools.js";
import { VERSION } from "../../shared/src/version.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import { createApplicationWorkflow } from "./application-config.js";
import { registerApplicationTools } from "./application-tools.js";
import { ApplicationMcpServer } from "./application-server.js";
import { registerWorkspaceTools } from "./workspace-tools.js";
import { Workspace } from "../../workspace/src/store.js";
import type { FileOpener } from "../../workspace/src/open.js";
import { WaterlooWorksSource } from "../../workspace/src/sources/waterlooworks.js";
import {
  type WaterlooWorksClient,
  type JobPosting,
  type JobSearchQuery,
  type JobSearchItem,
  type JobSort,
  type WaterlooWorksHealth,
} from "../../waterlooworks-client/src/index.js";

export interface McpServerDependencies {
  client?: Pick<WaterlooWorksClient, "bootstrap" | "health" | "searchJobs" | "getJob" | "getSearchMetadata" | "getAccountOverview" | "getDocumentMetadata" | "getEmployerReport">;
  applications?: ApplicationWorkflow;
  workspace?: Workspace;
  /** Opens newly created PDFs for the user; tests inject a no-op. */
  openFile?: FileOpener;
}

type LooseToolRegistrar = (
  name: string,
  config: { description: string; inputSchema?: Record<string, unknown> },
  handler: (args: unknown) => Promise<CallToolResult>,
) => unknown;

interface SearchToolArgs {
  keyword?: string;
  filters?: Record<string, unknown> | null;
  sort?: JobSort[];
}

interface GetJobToolArgs {
  jobId: string;
  includePreScreening?: boolean;
}

interface AccountOverviewToolArgs {
  selectedTerm?: string;
  numOfDays?: number;
}

interface EmployerReportToolArgs {
  companyId: string;
}

const WATERLOOWORKS_MCP_INSTRUCTIONS = `
You are using a local WaterlooWorks MCP server for research and human-approved
Full-Cycle co-op applications. Do not ask the user to paste cookies, session
IDs, action tokens, or passwords. Sign-in remains in the user's browser.

Local workspace (data/): the user's profile, experience draft, resume variants,
saved jobs, cover letters, and application plans are stored by the workspace_*,
profile_*, experience_save, resume_*, jobs_*, job_*, cover_letter_save, and
application_plan_save tools. Use them instead of writing files by hand. Resume
and cover letter content must come only from the user's experience draft and
profile. Plans become "ready" for the local dashboard (dashboard_open); only the
user applies from that page. Never open, click, or call the dashboard API.

Work authorization for Canadian citizens (profile workAuthorization.canada =
"citizen"): they may work for any employer in Canada with no permit, visa, or
sponsorship. Answer "eligible to work in Canada" Yes and "require sponsorship
in Canada" No. Citizenship makes them eligible to apply for Canadian security
clearance but does not mean they hold one. Canadian citizenship is not US work
authorization: unless the profile records US citizenship or a green card,
answer "authorized to work in the US" No and "require US sponsorship" per
needsSponsorship.unitedStates (usually Yes; co-op terms usually need a J-1).
Canadian citizens are not "U.S. persons" for ITAR/EAR. Remote work follows
where it is performed. Never infer statuses the profile does not state.

Application workflow:
1. Read waterlooworks_get_application_form and waterlooworks_list_documents.
2. Use exact question IDs/options and generated or data/ PDFs for attachments.
   Never invent personal answers.
3. waterlooworks_prepare_application optionally validates a draft without writes.
4. Save the result with application_plan_save. Agents have no write tools: only the
   user applies, from the extension dashboard, and the extension refuses writes
   without an approval minted by that click. Never try to reach the dashboard API,
   the bridge, or the browser to approve or submit.
5. Read outcomes with jobs_list and waterlooworks_get_operation_status. Never retry
   uncertain submissions. Global default-document changes are unsupported.
Only Full-Cycle internal applications are supported. Report employer website
steps as outstanding; an internal receipt does not complete external steps.

Recommended research workflow:
1. Check connectivity with waterlooworks_status when starting a task, when
   authentication is unknown, or after a request fails. Continue only when
   authenticated, bridgeConnected, and bootstrapped are true.
2. Find candidates with waterlooworks_search_jobs. Start with a focused
   keyword; add filters or sort when the user gives structured criteria. The
   search is intentionally unpaged: it returns every match and does not accept
   page or itemsPerPage. Use total and the returned summary fields to shortlist
   postings before requesting details. Do not fetch full details for every
   result unless the user explicitly asks for that.
3. Inspect shortlisted postings with waterlooworks_get_job using the numeric
   id from search results. It returns the normalized description, duties,
   qualifications, location, work term, compensation, application details,
   service-team contacts, and status. Pre-screening is included by default and
   is returned as parsed text plus questions and answer options, not raw HTML.
   Set includePreScreening to false only when those questions are not relevant.
4. Evaluate employer history with waterlooworks_get_employer_report after
   getting a posting's details. Prefer the posting's numeric divisionId as
   companyId when it is present; never invent an ID from an employer name. Read
   analytics.hiringHistory, analytics.workTermRatingsSummary,
   analytics.hiresByFaculty, analytics.hiresByStudentWorkTermNumber,
   analytics.mostFrequentlyHiredPrograms,
   analytics.overallWorkTermSatisfaction, and
   analytics.averageRatingByQuestion, along with analytics.charts. The
   report is a hiring-history/work-term-ratings summary; distinguish missing
   data from a measured zero and retain the organization/division context. If
   reportAvailable is false, treat that as a normal no-history result: report
   that WaterlooWorks has no employer report data and do not retry repeatedly.

Tool selection:
- waterlooworks_get_search_metadata discovers the current search columns,
  sort defaults, filter definitions, and saved filters. Use it before building
  an advanced filters object when the filter names or values are unknown.
- waterlooworks_get_account_overview and
  waterlooworks_get_document_metadata are optional read-only account tools;
  call them only when the user asks about folders, application counts, or
  document defaults.

Authentication recovery:
Status checks and background reconciliation never open sign-in tabs. If status
reports authenticated=false, ask the user to sign in to WaterlooWorks in the
extension's browser profile when they are ready to use it. Authentication failures
during explicitly requested research or preparation reads open sign-in, reusing
an existing WaterlooWorks tab where possible. Ask the user to complete login in
that tab, then recheck status and retry read requests. Failed writes are never
replayed automatically. The extension owns all
WaterlooWorks requests and keeps credentials in the browser. If status
remains false after sign-in, have the user reload the extension
and reconnect the MCP server. Never expose or request credential material.

When presenting results, keep the search shortlist separate from full posting
facts and employer analytics. State which fields are absent, avoid treating
inferred fit as WaterlooWorks data. Unknown forms, changed inputs, broken
documents, existing applications, and unapproved writes must stop safely.
`.trim();

function publicSearchItem(item: JobSearchItem): Record<string, unknown> {
  const { raw: _raw, ...publicItem } = item;
  return publicItem;
}

function publicPosting(posting: JobPosting): Record<string, unknown> {
  const { raw: _raw, ...publicPostingValue } = posting;
  return publicPostingValue;
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "WaterlooWorks request failed";
  return {
    isError: true,
    content: [{ type: "text", text: resultText({ error: message }) }],
  };
}

export function createWaterlooWorksMcpServer(dependencies: McpServerDependencies = {}): McpServer {
  const client = dependencies.client ?? new ExtensionResearchClient();
  const applications = dependencies.applications ?? createApplicationWorkflow();
  const server = new ApplicationMcpServer(applications,
    { name: "waterlooworks-mcp", version: VERSION },
    { instructions: WATERLOOWORKS_MCP_INSTRUCTIONS },
  );
  // The SDK's recursive Zod compatibility types are expensive for Bun's
  // TypeScript checker. Runtime validation still happens inside the SDK; this
  // local adapter keeps the rest of the implementation strongly typed.
  const registerTool = server.registerTool.bind(server) as unknown as LooseToolRegistrar;

  registerTool(
    "waterlooworks_status",
    {
      description:
        "Check WaterlooWorks authentication, browser bridge, and bootstrap status. Use at the start of a research task or after an authentication/request failure.",
    },
    async (_args: unknown): Promise<CallToolResult> => {
      try {
        const health: WaterlooWorksHealth = await client.health();
        const structuredHealth: Record<string, unknown> = { ...health, applications: applications.capabilities };
        return { content: [{ type: "text", text: resultText(structuredHealth) }], structuredContent: structuredHealth };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "waterlooworks_search_jobs",
    {
      description:
        "Search current WaterlooWorks co-op job postings by keyword and filters. Results are returned as one unpaged set; use this to shortlist posting IDs before calling waterlooworks_get_job.",
      inputSchema: {
        keyword: z.string().optional().describe("Keyword or phrase to search for"),
        filters: z.record(z.string(), z.unknown()).nullable().optional().describe("WaterlooWorks DataViewer filters"),
        sort: z
          .array(z.object({ key: z.string(), direction: z.string() }))
          .optional()
          .describe("Sort fields, for example [{key: 'Id', direction: 'desc'}]"),
      },
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      try {
        const { keyword, filters, sort } = rawArgs as SearchToolArgs;
        const query: JobSearchQuery = {};
        if (keyword !== undefined) query.keyword = keyword;
        if (filters !== undefined) query.filters = filters;
        if (sort !== undefined) query.sort = sort;
        const result = await client.searchJobs(query);
        const publicResult = {
          items: result.items.map(publicSearchItem),
          total: result.total,
        };
        return {
          content: [{ type: "text", text: resultText(publicResult) }],
          structuredContent: publicResult,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "waterlooworks_get_search_metadata",
    {
      description:
        "Return WaterlooWorks search columns, sort defaults, filter definitions, and saved filters. Use before constructing advanced filters when their names or values are unknown.",
    },
    async (_args: unknown): Promise<CallToolResult> => {
      try {
        const metadata = await client.getSearchMetadata();
        const publicValue = { ...metadata };
        return { content: [{ type: "text", text: resultText(publicValue) }], structuredContent: publicValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "waterlooworks_get_job",
    {
      description:
        "Retrieve normalized full posting data for one shortlisted posting, including rich description, application details, divisionId, and parsed pre-screening questions/options. Call after waterlooworks_search_jobs and before employer history.",
      inputSchema: {
        jobId: z.string().regex(/^\d+$/).describe("WaterlooWorks posting ID"),
        includePreScreening: z.boolean().optional().describe("Retrieve pre-screening questions/content; defaults to true"),
      },
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      try {
        const { jobId, includePreScreening } = rawArgs as GetJobToolArgs;
        const getJobOptions: { includePreScreening?: boolean } = {};
        getJobOptions.includePreScreening = includePreScreening ?? true;
        const posting = await client.getJob(jobId, getJobOptions);
        const publicValue = publicPosting(posting);
        return { content: [{ type: "text", text: resultText(publicValue) }], structuredContent: publicValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "waterlooworks_get_account_overview",
    {
      description: "Retrieve read-only WaterlooWorks account collections and application summary metadata.",
      inputSchema: {
        selectedTerm: z.string().optional().describe("WaterlooWorks term identifier for application statistics"),
        numOfDays: z.number().int().min(0).optional().describe("Recent-day window for application statistics; 0 means all available"),
      },
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      try {
        const { selectedTerm, numOfDays } = rawArgs as AccountOverviewToolArgs;
        const options: AccountOverviewToolArgs = {};
        if (selectedTerm !== undefined) options.selectedTerm = selectedTerm;
        if (numOfDays !== undefined) options.numOfDays = numOfDays;
        const overview = await client.getAccountOverview(options);
        const publicValue: Record<string, unknown> = { ...overview };
        return { content: [{ type: "text", text: resultText(publicValue) }], structuredContent: publicValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "waterlooworks_get_document_metadata",
    {
      description: "Retrieve read-only default document and document-package metadata from WaterlooWorks.",
    },
    async (_args: unknown): Promise<CallToolResult> => {
      try {
        const metadata = await client.getDocumentMetadata();
        const publicValue: Record<string, unknown> = { ...metadata };
        return { content: [{ type: "text", text: resultText(publicValue) }], structuredContent: publicValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "waterlooworks_get_employer_report",
    {
      description:
        "Retrieve the read-only employer hiring-history and work-term ratings summary, including normalized analytics tables/charts. Call after waterlooworks_get_job and pass its numeric divisionId as companyId when available. Employers without report data return reportAvailable=false with sections=[].",
      inputSchema: {
        companyId: z.string().regex(/^\d+$/).describe("WaterlooWorks employer or division report ID"),
      },
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      try {
        const { companyId } = rawArgs as EmployerReportToolArgs;
        const report = await client.getEmployerReport(companyId);
        const publicValue: Record<string, unknown> = { ...report };
        return { content: [{ type: "text", text: resultText(publicValue) }], structuredContent: publicValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerApplicationTools(server, applications);
  registerDiscoveryTools(server);
  const workspace = dependencies.workspace ?? new Workspace();
  registerWorkspaceTools(server, workspace, new Map([["waterlooworks", new WaterlooWorksSource(client, applications)]]), dependencies.openFile);
  return server;
}
