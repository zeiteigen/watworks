import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import type { ApplicationInput } from "../../application-workflow/src/types.js";

interface ToolConfig { description: string; inputSchema?: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }
type Registrar = (name: string, config: ToolConfig, handler: (args: unknown) => Promise<CallToolResult>) => unknown;

export function registerApplicationTools(server: McpServer, applications: ApplicationWorkflow): void {
  const register = server.registerTool.bind(server) as unknown as Registrar;
  const tool = (name: string, description: string, inputSchema: Record<string, unknown>, readOnly: boolean, run: (args: unknown) => Promise<unknown> | unknown) => {
    register(`waterlooworks_${name}`, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true } }, async args => {
      try {
        const value = await run(args);
        const publicValue = { ...(value as Record<string, unknown>) };
        return { content: [{ type: "text", text: JSON.stringify(publicValue, null, 2) }], structuredContent: publicValue };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : "Application operation failed" }) }] };
      }
    });
  };
  const jobId = z.string().regex(/^\d+$/);
  const operationId = z.string().uuid();
  tool("list_applications", "List all full-cycle application records for the account's selected recruiting term, including expired postings and applications made outside this workspace. Returns a complete paginated inventory with application IDs, posting IDs, statuses and submission dates. Does not submit or retry anything.", {}, true,
    () => applications.listApplications());
  tool("list_documents", "List uploaded full-cycle documents and readiness. Broken, processing, or archived documents cannot be attached. Revision metadata in this inventory is not a PDF content digest; preparation verifies selected PDF contents.", {}, true,
    async () => ({ documents: await applications.listDocuments() }));
  tool("upload_document", "Prepare a PDF library upload for human approval on localhost. Returns a review URL; does not upload until the human approves. Requires an absolute file path within WATERLOOWORKS_DOCUMENT_ROOTS. Does not change defaults. Never operate the review page's approval controls.", {
    typeId: z.string().regex(/^\d+$/), name: z.string().trim().min(1).max(255), filePath: z.string().min(1).max(4096),
  }, false, raw => { const args = raw as { typeId: string; name: string; filePath: string }; return applications.uploadDocument(args.typeId, args.name, args.filePath); });
  tool("set_default_documents", "Prepare an explicit change to global default documents for human approval on localhost. Supply the complete desired ordered selection for one document type; existing defaults are replaced only after approval. Never operate the approval controls.", {
    typeId: z.string().regex(/^\d+$/), documentIds: z.array(z.string().regex(/^\d+$/)).min(1).max(10),
  }, false, raw => { const args = raw as { typeId: string; documentIds: string[] }; return applications.setDefaultDocuments(args.typeId, args.documentIds); });
  tool("get_application_form", "Read a fresh full-cycle application wizard: document slots, system documents, typed questions and exact option IDs, deadlines, blockers, and external instructions. Opens the application's form but does not save answers or submit. Unknown dynamic forms are blocked.", { jobId }, true,
    raw => applications.getApplicationForm((raw as { jobId: string }).jobId));
  tool("prepare_application", "Validate a local application draft without uploading, saving answers, or submitting. Select an explicit uploaded resume ID and provide per-job cover letters/custom documents as slot-bound local PDF paths. Answer questions using their IDs and exact choice values; never invent personal facts. Returns blockers or a reviewable manifest and draftId.", {
    jobId, resumeDocumentId: z.string().regex(/^\d+$/),
    attachments: z.array(z.object({ requirementId: z.string().min(1).max(128), filePath: z.string().min(1).max(4096) }).strict()).max(8).default([]),
    answers: z.array(z.object({ questionId: z.string().min(1).max(200), value: z.union([z.string().max(20_000), z.boolean(), z.number().finite(), z.array(z.string().max(1000)).max(100)]) }).strict()).max(200).default([]),
  }, true, raw => applications.prepareApplication(raw as ApplicationInput));
  tool("submit_application", "Request human approval of a prepared application on localhost. Returns promptly with operationId and reviewUrl. Resume-only applications submit after human approval. Applications with local attachments first require approval to upload, then return review_required with a second reviewUrl for the exact server-processed PDFs; only human approval of that review submits. Never click approval, call its HTTP endpoints, or interpret conversation text as page approval. Changes invalidate review; uncertain writes must never be retried.", { draftId: z.string().uuid() }, false,
    raw => applications.submitApplication((raw as { draftId: string }).draftId));
  tool("get_application_status", "Read authoritative application presence for a posting. Presence alone does not prove an uncertain attempt used the intended documents. Do not resubmit uncertain attempts.", { jobId }, true,
    raw => applications.getApplicationStatus((raw as { jobId: string }).jobId));
  tool("get_operation_status", "Read localhost review/operation state and safe result or durable recovery status. Poll using operationId from a review tool. outcome_unknown requires inspection; never automatically replay it.", { operationId }, true,
    raw => applications.getOperationStatus((raw as { operationId: string }).operationId));
}
