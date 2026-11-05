import { expect, test } from "bun:test";
import { WaterlooWorksSource } from "./waterlooworks.js";
import type { WaterlooWorksClient } from "../../../waterlooworks-client/src/client.js";
import type { ApplicationWorkflow } from "../../../application-workflow/src/workflow.js";

test("workspace search preserves applied flags so agents can exclude applications made outside the workspace", async () => {
  const client = { searchJobs: async () => ({ total: 3, items: [{ id: "123", titleFlags: { applied: true } }, { id: "124", hasApplication: false, titleFlags: { applied: true } }, { id: "125" }] }) } as unknown as WaterlooWorksClient;
  const source = new WaterlooWorksSource(client, {} as ApplicationWorkflow);
  expect((await source.search({})).results.map(item => item.hasApplication)).toEqual([true, false, undefined]);
});
