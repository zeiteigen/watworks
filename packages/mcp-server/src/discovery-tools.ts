import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExtensionCommandProxy } from "../../bridge/src/extension-proxy.js";
import { DiscoveryPolicySchema } from "../../shared/src/discovery-policy.js";

export function registerDiscoveryTools(server: McpServer): void {
  const proxy = new ExtensionCommandProxy();
  const register = server.registerTool.bind(server) as unknown as (name: string, config: {description: string; inputSchema: Record<string,z.ZodTypeAny>}, handler: (args: unknown) => Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>) => void;
  const tool = (name: string, method: "discoveryPolicyGet" | "discoveryPolicySave" | "discoveriesList", description: string, inputSchema: Record<string, z.ZodTypeAny>) => {
    register(name, { description, inputSchema }, async args => {
      try {
        const result = await proxy.call(method, ...(method === "discoveryPolicySave" ? [(args as { policy: unknown }).policy] : []));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Extension unavailable" }] }; }
    });
  };
  tool("discovery_policy_get", "discoveryPolicyGet", "Read the submission server's daily job matching policy.", {});
  tool("discovery_policy_save", "discoveryPolicySave", "Save explainable daily matching rules derived from the user's targets and preferences. The submission server scans independently each day; the first scan evaluates existing postings. Configure at least one matching rule when the score threshold is positive.", { policy: DiscoveryPolicySchema });
  tool("discoveries_list", "discoveriesList", "Read interesting postings found by the submission server so an agent can prepare their applications.", {});
}
