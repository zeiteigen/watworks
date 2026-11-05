import { z } from "zod";

export const applicationProgressSchema = z.object({
  phase:z.enum(["checking_form", "checking_documents", "opening_application", "opening_upload", "uploading_document", "saving_document", "verifying_document", "verifying_documents", "filling_prescreen", "advancing_form", "filling_documents", "waiting_validation", "submitting", "verifying_submission"]),
  document:z.enum(["resume", "cover_letter", "attachment"]).optional(),
}).strict();
export type ApplicationProgress = z.infer<typeof applicationProgressSchema>;

export function progressLabel(progress: ApplicationProgress): string {
  const document = progress.document === "resume" ? "resume" : progress.document === "cover_letter" ? "cover letter" : "attachment";
  switch (progress.phase) {
    case "checking_form": return "Checking the application form";
    case "checking_documents": return "Checking uploaded documents";
    case "opening_application": return "Opening the application form";
    case "opening_upload": return `Opening the ${document} uploader`;
    case "uploading_document": return `Uploading ${document}`;
    case "saving_document": return `Saving uploaded ${document}`;
    case "verifying_document": return `Verifying processed ${document}`;
    case "verifying_documents": return "Verifying documents";
    case "filling_prescreen": return "Filling out prescreening answers";
    case "advancing_form": return "Advancing to the next form step";
    case "filling_documents": return "Selecting documents and filling the application form";
    case "waiting_validation": return "Waiting for WaterlooWorks to validate the form";
    case "submitting": return "Submitting the application";
    case "verifying_submission": return "Verifying the submission in WaterlooWorks";
  }
}
