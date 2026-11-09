import { validateAnswers } from "./validate-answers.js";
import type { ApplicationForm, ApplicationInput, ApplicationManifest, LibraryDocument, PreparedFile } from "./types.js";

export function validateApplication(
  form: ApplicationForm,
  input: ApplicationInput,
  documents: LibraryDocument[],
  files: ReadonlyMap<string, PreparedFile>,
  now = Date.now(),
): { blockers: string[]; manifest?: ApplicationManifest } {
  const blockers = [...form.blockers];
  if (form.jobId !== input.jobId) blockers.push("Posting ID changed");
  if (!/^[a-f0-9]{64}$/.test(form.accountKey)) blockers.push("Verified account identity is unavailable");
  if (!form.title || !form.employer || !form.term || !form.version) blockers.push("Application identity or version is incomplete");
  if (!form.canApply || form.hasApplication) blockers.push("Posting is unavailable or already has an application");
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(form.deadline) || !Number.isFinite(Date.parse(form.deadline)) || Date.parse(form.deadline) <= now) blockers.push("Application deadline is unknown or has passed");
  const requirementIds = form.requirements.map(item => item.id);
  if (new Set(requirementIds).size !== requirementIds.length) blockers.push("Duplicate document requirement IDs");
  if (form.requirements.filter(item => item.role === "resume").length !== 1) blockers.push("Exactly one resume slot must be understood");
  const attachmentIds = input.attachments.map(item => item.requirementId);
  if (new Set(attachmentIds).size !== attachmentIds.length) blockers.push("Duplicate document attachment");
  for (const id of attachmentIds) if (!form.requirements.some(item => item.id === id && item.role === "attachment")) blockers.push(`Unsupported attachment slot: ${id}`);
  const selected: ApplicationManifest["documents"] = [];
  for (const slot of form.requirements) {
    if (slot.role === "attachment") {
      const file = files.get(slot.id);
      if (!file) { if (slot.required) blockers.push(`Missing document: ${slot.label}`); continue; }
      selected.push({ requirementId: slot.id, label: slot.label, file: { filename: file.filename, size: file.size, sha256: file.sha256 } });
    } else {
      if (slot.role === "system" && !slot.required && !slot.selectedDocument) continue;
      const doc = slot.role === "resume" ? documents.find(item => item.id === input.resumeDocumentId) : slot.selectedDocument;
      if (!doc || doc.typeId !== slot.typeId || doc.state !== "ready" || !doc.revision || (slot.role === "resume" && doc.source !== "library") || (slot.role === "system" && doc.source !== "system")) {
        blockers.push(`Document is missing, changed, or not ready: ${slot.label}`); continue;
      }
      selected.push({ requirementId: slot.id, label: slot.label, document: { ...doc } });
    }
  }
  const {blockers: answerBlockers, answers: reviewed} = validateAnswers(form.questions, input.answers);
  blockers.push(...answerBlockers);
  if (blockers.length) return { blockers };
  return { blockers, manifest: {
    kind: "application", accountKey: form.accountKey, accountLabel: form.accountLabel,
    jobId: form.jobId, title: form.title, employer: form.employer, term: form.term,
    deadline: form.deadline, formVersion: form.version, documents: selected,
    answers: reviewed, externalSteps: [...form.externalSteps],
  } };
}
