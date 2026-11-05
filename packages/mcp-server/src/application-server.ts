import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";

/** Finish in-flight approved operations before releasing their process and session. */
export class ApplicationMcpServer extends McpServer {
  constructor(private readonly applications: ApplicationWorkflow, info: { name: string; version: string }, options: { instructions: string }) {
    super(info, options);
  }
  override async close(): Promise<void> {
    try { await this.applications.close(); }
    finally { await super.close(); }
  }
}
