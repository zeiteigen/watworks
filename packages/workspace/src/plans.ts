import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readApplicationPdf } from "../../application-workflow/src/files.js";
import { validateApplication } from "../../application-workflow/src/validate.js";
import type { ApplicationForm, ApplicationInput, PreparedFile } from "../../application-workflow/src/types.js";
import type { JobKey } from "./paths.js";
import type { ApplicationPlan } from "./schemas.js";
import type { Workspace } from "./store.js";

const PLANNED_RESUME_ID = "planned-resume";

/** Absolute PDF path for a plan attachment; user files must live inside data/. */
export function attachmentPath(workspace: Workspace, key: JobKey, attachment: ApplicationPlan["attachments"][number]): string {
  if (attachment.kind === "cover_letter") return workspace.paths.job(key).coverLetterPdf;
  if (attachment.kind === "document") return workspace.paths.jobDocument(key, attachment.document).pdf;
  return isAbsolute(attachment.path) ? attachment.path : join(workspace.paths.root, attachment.path);
}

export function toApplicationInput(workspace: Workspace, key: JobKey, plan: ApplicationPlan, resumeDocumentId: string): ApplicationInput {
  return {
    jobId: key.jobId,
    resumeDocumentId,
    attachments: plan.attachments.map(item => ({ requirementId: item.requirementId, filePath: attachmentPath(workspace, key, item) })),
    answers: plan.answers.map(item => ({ questionId: item.questionId, value: structuredClone(item.value) })),
  };
}

/**
 * Check a plan against the saved application form with the same validator used
 * at submission. The resume is not uploaded yet, so it stands in as a ready library document.
 */
export async function planBlockers(workspace: Workspace, key: JobKey, plan: ApplicationPlan, form: ApplicationForm | undefined, resumePdf = workspace.paths.resume(plan.resumeVariant).pdf): Promise<string[]> {
  const blockers: string[] = [];
  if (!existsSync(resumePdf)) blockers.push(`Resume variant "${plan.resumeVariant}" has no compiled PDF`);
  if (!form) return [...blockers, "No application form is saved for this job; it cannot be applied to from the dashboard"];
  const files = new Map<string, PreparedFile>();
  for (const attachment of plan.attachments) {
    try { files.set(attachment.requirementId, await readApplicationPdf(attachmentPath(workspace, key, attachment), [workspace.paths.root])); }
    catch (error) { blockers.push(`Attachment ${attachment.requirementId}: ${error instanceof Error ? error.message : "unreadable"}`); }
  }
  const resumeSlot = form.requirements.find(slot => slot.role === "resume");
  const standIn = resumeSlot ? [{ id: PLANNED_RESUME_ID, typeId: resumeSlot.typeId, name: "Planned resume", revision: "planned", state: "ready" as const, source: "library" as const }] : [];
  const result = validateApplication(form, toApplicationInput(workspace, key, plan, PLANNED_RESUME_ID), standIn, files);
  return [...new Set([...blockers, ...result.blockers])];
}
