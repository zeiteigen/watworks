import { applicationDeadline } from "../../waterlooworks-client/src/application-deadline.js";
import { parseJobKey, type JobKey } from "../../workspace/src/paths.js";
import type { Workspace, JobRecord } from "../../workspace/src/store.js";

const DISCARDABLE = new Set(["found", "planned", "ready", "failed", "skipped"]);

export async function jobExpired(workspace: Workspace, job: Pick<JobRecord, "key" | "posting">, now = Date.now()): Promise<boolean> {
  const form = await workspace.getForm(parseJobKey(job.key));
  const deadline = applicationDeadline(form?.deadline) || applicationDeadline(job.posting.summary.deadline);
  return Boolean(deadline) && Date.parse(deadline) <= now;
}

/** Archive closed opportunities without deleting materials or hiding submission outcomes. */
export async function discardExpiredJobs(workspace: Workspace, isActive: (key: JobKey) => boolean, now = Date.now()): Promise<void> {
  for (const job of await workspace.listJobs()) {
    const key = parseJobKey(job.key);
    if (job.status.removedFromQueueAt || !DISCARDABLE.has(job.status.state) || isActive(key) || !await jobExpired(workspace, job, now)) continue;
    const status = await workspace.getStatus(key);
    if (!status || status.removedFromQueueAt || !DISCARDABLE.has(status.state) || isActive(key)) continue;
    await workspace.setStatus(key, { state: "skipped", removedFromQueueAt: new Date(now).toISOString(), reason: "Automatically discarded: application deadline has passed", blockers: [], externalSteps: status.externalSteps });
  }
}
