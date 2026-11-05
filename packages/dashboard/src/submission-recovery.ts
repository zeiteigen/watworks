import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import { parseJobKey } from "../../workspace/src/paths.js";
import type { Workspace } from "../../workspace/src/store.js";
import { planBlockers } from "../../workspace/src/plans.js";

/** Local recovery remains available when WaterlooWorks application-history reads fail. */
export class SubmissionRecovery {
  constructor(private readonly workspace: Workspace,
    private readonly workflow: Pick<ApplicationWorkflow, "getBlockingAttempts" | "releaseSubmissionBlock" | "authorizeApplicationRetry" | "getApplicationForm" | "getApplicationStatus" | "listApplications" | "reconcileApplication">,
    private readonly hasActive: () => boolean) {}

  async list() {
    const jobs = await this.workspace.listJobs();
    const forms = await Promise.all(jobs.map(async job => ({ job, form: await this.workspace.getForm(parseJobKey(job.key)).catch(() => undefined) })));
    return this.workflow.getBlockingAttempts().map(attempt => {
      const match = forms.find(({ form }) => form && (attempt.kind === "stage_application_documents"
        ? fingerprint(["stage_documents",form.accountKey,form.jobId,attempt.manifestHash])
        : fingerprint(["application", form.accountKey, form.jobId, form.term])) === attempt.operationKey);
      const delay = attempt.state === "outcome_unknown" ? 120_000 : 300_000;
      const oldEnough = Date.now() - Math.max(attempt.createdAt, attempt.updatedAt) >= delay;
      return {
        id: attempt.attemptId, state: attempt.state, kind: attempt.kind,
        createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
        jobKey: match?.job.key ?? null, title: match?.job.posting.summary.title ?? null,
        employer: match?.job.posting.summary.employer ?? null,
        canRelease: oldEnough && !this.hasActive(),
        releaseDisabledReason: this.hasActive() ? "Wait for queued operations to finish."
          : !oldEnough ? attempt.state === "outcome_unknown" ? "Wait two minutes after the uncertain attempt." : "This operation may still be in progress. Release is available after five minutes without updates." : null,
      };
    });
  }

  release(id: string, updatedAt: number, reason: string): void {
    if (this.hasActive()) throw new Error("Wait for queued operations to finish before releasing a block");
    this.workflow.releaseSubmissionBlock(id, updatedAt, reason);
  }

  async unlockRetry(key: ReturnType<typeof parseJobKey>): Promise<void> {
    if (key.source !== "waterlooworks") throw new Error("Unsupported job source");
    if (this.hasActive()) throw new Error("Wait for queued operations to finish before checking a retry");
    const form = await this.workspace.getForm(key);
    if (!form) throw new Error("No saved application form is available");
    await this.workflow.authorizeApplicationRetry(key.jobId, form.term);
  }

  /** One human recovery action checks presence, unlocks verified absence, and validates preparation. */
  async recover(key: ReturnType<typeof parseJobKey>, updatedAt: string) {
    if (key.source !== "waterlooworks" || this.hasActive()) throw new Error("Wait for active applications to finish before checking this job");
    const saved = await this.workspace.getForm(key);
    if (!saved) throw new Error("Ask your agent to refresh this posting and save its application form first.");
    const remote = await this.workflow.getApplicationStatus(key.jobId, saved.accountKey);
    // WaterlooWorks no longer exposes an application form once a posting is applied.
    const form = remote.hasApplication ? saved : await this.workflow.getApplicationForm(key.jobId);
    if (form.accountKey !== saved.accountKey || form.term !== saved.term || form.jobId !== key.jobId || remote.jobId !== key.jobId) throw new Error("The WaterlooWorks account or recruiting term changed. Sign in to the original account and try again.");
    if (!remote.hasApplication) {
      if (form.hasApplication) throw new Error("WaterlooWorks returned conflicting application status. Check the posting before trying again.");
      await this.workflow.authorizeApplicationRetry(key.jobId, form.term);
    } else {
      // Resolve an old account block from verified presence when history is available.
      const inventory = await this.workflow.listApplications().catch(() => undefined);
      if (inventory) {
        if (inventory.accountKey !== saved.accountKey) throw new Error("WaterlooWorks account changed during the check");
        await this.workflow.reconcileApplication(key.jobId, saved.term, inventory);
      }
    }
    const current = await this.workspace.getStatus(key);
    if (this.hasActive() || current?.updatedAt !== updatedAt || current.removedFromQueueAt) throw new Error("This job changed during the check. Refresh and review it again.");
    await this.workspace.saveForm(key, form);
    if (remote.hasApplication) return this.workspace.setStatus(key, { state: "applied", reason: "Application verified in WaterlooWorks", externalSteps: form.externalSteps });
    const plan = await this.workspace.getPlan(key);
    const blockers = plan ? await planBlockers(this.workspace, key, plan, form) : ["No saved application plan. Ask your agent to prepare this job."];
    return this.workspace.setStatus(key, { state: blockers.length ? "planned" : "ready", blockers,
      reason: blockers.length ? "No application was submitted. Complete the requirements below before applying." : "No application was submitted. Ready for you to review and apply again.", externalSteps: form.externalSteps });
  }
}
