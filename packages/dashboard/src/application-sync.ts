import type { ApplicationInventory } from "../../application-workflow/src/types.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import type { Workspace } from "../../workspace/src/store.js";
import { parseJobKey } from "../../workspace/src/paths.js";
import { planBlockers } from "../../workspace/src/plans.js";

/** Periodic read-only remote reconciliation, independent of the dashboard tab. */
export class ApplicationSync {
  private pending: Promise<ApplicationInventory> | undefined;
  private last: ApplicationInventory | undefined;
  constructor(private readonly workspace: Workspace, private readonly workflow: ApplicationWorkflow,
    private readonly isActive: (key: ReturnType<typeof parseJobKey>) => boolean) {}

  refresh(force = false): Promise<ApplicationInventory> {
    if (this.pending) return this.pending;
    if (!force && this.last && Date.now() - Date.parse(this.last.checkedAt) < 30_000) return Promise.resolve(this.last);
    this.pending = this.read().then(inventory => { this.last = inventory; return inventory; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** Inventory viewing is a local browser read and never runs submission reconciliation. */
  list():Promise<ApplicationInventory> { return this.workflow.listApplications(); }

  private async read(): Promise<ApplicationInventory> {
    const inventory = await this.workflow.listApplications();
    for (const job of await this.workspace.listJobs()) {
      const key = parseJobKey(job.key);
      if (key.source !== "waterlooworks" || this.isActive(key)) continue;
      const form = await this.workspace.getForm(key);
      if (!form || form.accountKey !== inventory.accountKey) continue;
      // Legacy forms could contain compensation text as their term. A complete
      // account-bound inventory plus authoritative presence can repair a filled receipt.
      const malformedFilledTerm = job.status.state === "form_filled" && !/^\d{4} - (Winter|Spring|Summer|Fall)$/.test(form.term);
      const matches = inventory.applications.filter(item => item.jobId === key.jobId && item.status === "Applied"
        && (item.term === form.term || malformedFilledTerm));
      const application = matches.length === 1 ? matches[0] : undefined;
      if (application) {
        if (job.status.state === "applied") continue;
        const result = await this.workflow.reconcileApplication(key.jobId, form.term, inventory);
        if (!result.hasApplication || this.isActive(key)) continue;
        if (malformedFilledTerm && application.term !== form.term) await this.workspace.saveForm(key,{...form,term:application.term});
        await this.workspace.setStatus(key, { state: "applied", applicationId: application.applicationId,
          reason: `Application presence verified in WaterlooWorks (${inventory.checkedAt}); document contents were not reverified`, externalSteps: form.externalSteps });
      } else if (job.status.state === "form_filled" && Date.now() - Date.parse(job.status.updatedAt) >= 120_000) {
        const result = await this.workflow.reconcileFilledApplication(key.jobId, form.term, inventory);
        if (result.hasApplication || this.isActive(key)) continue;
        const checkedForm = malformedFilledTerm ? await this.workflow.getApplicationForm(key.jobId) : form;
        if (checkedForm.accountKey !== inventory.accountKey || (malformedFilledTerm && (checkedForm.jobId !== key.jobId || checkedForm.hasApplication))) throw new Error("Application changed during local reconciliation");
        const current = await this.workspace.getStatus(key);
        if (this.isActive(key) || current?.state !== "form_filled" || current.updatedAt !== job.status.updatedAt) continue;
        const plan = await this.workspace.getPlan(key);
        const blockers = plan ? await planBlockers(this.workspace, key, plan, checkedForm) : ["No saved application plan"];
        if (malformedFilledTerm) await this.workspace.saveForm(key,checkedForm);
        await this.workspace.setStatus(key, { state: blockers.length ? "planned" : "ready", blockers,
          reason: "The filled form was not submitted in WaterlooWorks. Review and apply again when ready.", externalSteps: checkedForm.externalSteps });
      } else if (["applying", "outcome_unknown", "failed"].includes(job.status.state)
        && Date.now() - Date.parse(job.status.updatedAt) >= 120_000) {
        const result = await this.workflow.reconcileApplication(key.jobId, form.term, inventory);
        if (!result.hasApplication && !this.isActive(key) && !job.status.reason?.startsWith("No submitted application verified")) await this.workspace.setStatus(key, {
          state: "failed", reason: `No submitted application verified in WaterlooWorks as of ${inventory.checkedAt}. The previous attempt is not retried automatically.`, externalSteps: job.status.externalSteps });
      }
    }
    return inventory;
  }
}
