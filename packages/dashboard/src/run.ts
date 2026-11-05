import { LocalApplicationGateway } from "../../bridge/src/local-application-gateway.js";
import { SubmissionRecovery } from "./submission-recovery.js";
import { discardExpiredJobs } from "./queue-maintenance.js";
import { ReviewService } from "../../approval/src/index.js";
import { BridgeLifecycle } from "../../bridge/src/lifecycle.js";
import { ExtensionResearchClient, ExtensionCommandProxy } from "../../bridge/src/extension-proxy.js";
import { createApplicationWorkflow } from "../../mcp-server/src/application-config.js";
import { Workspace } from "../../workspace/src/store.js";
import { Applier } from "./applier.js";
import { ApplicationSync } from "./application-sync.js";
import { DASHBOARD_ORIGIN, DASHBOARD_PORT, probeDashboard } from "./launcher.js";
import { createDashboardFetch } from "./server.js";

/** Long-lived local dashboard. It also keeps the browser bridge alive after the agent exits. */
export async function runDashboard(): Promise<void> {
  if (await probeDashboard() !== undefined) {
    console.error(JSON.stringify({ event: "dashboard.already_running", origin: DASHBOARD_ORIGIN }));
    return;
  }
  const workspace = new Workspace();
  await workspace.scaffold();
  const bridge = new BridgeLifecycle();
  await bridge.start();
  // The dashboard is the approval surface, so its review service never serves HTTP.
  const reviews = new ReviewService({ serve: false });
  const workflow = createApplicationWorkflow({ reviews });
  const localWorkflow = createApplicationWorkflow({reviews,gateway:new LocalApplicationGateway()});
  const client = new ExtensionResearchClient();
  const applier = new Applier(workspace, workflow, reviews);
  const applications = new ApplicationSync(workspace, localWorkflow, key => applier.isActive(key));
  const sync = () => {
    void discardExpiredJobs(workspace, key => applier.isActive(key)).catch(error => console.error(JSON.stringify({ event: "queue.maintenance_failed", error: String(error) })));
    void applications.refresh().catch(error => console.error(JSON.stringify({ event: "applications.sync_failed", error: String(error) })));
  };
  sync();
  const syncTimer = setInterval(sync, 60_000);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: DASHBOARD_PORT,
    maxRequestBodySize: 4096,
    idleTimeout:255,
    fetch: createDashboardFetch(() => DASHBOARD_ORIGIN, {
      workspace, applier, applications, recovery: new SubmissionRecovery(workspace, localWorkflow, () => applier.hasActive), health: () => client.health(),
      submissionStatus: () => new ExtensionCommandProxy().call("getSubmissionStatus"),
    }),
  });
  console.error(JSON.stringify({ event: "dashboard.listening", origin: DASHBOARD_ORIGIN, dataDir: workspace.paths.root }));
  console.log("Workspace service ready. Open Dashboard from the WaterlooWorks extension.");
  const stop = async () => {
    clearInterval(syncTimer);
    await server.stop();
    await localWorkflow.close();
    await workflow.close();
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
