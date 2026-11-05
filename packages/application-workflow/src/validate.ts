import type { Answer, ApplicationForm, ApplicationInput, ApplicationManifest, LibraryDocument, PreparedFile } from "./types.js";

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
  const questions = new Map(form.questions.map(q => [q.id, q]));
  if (questions.size !== form.questions.length) blockers.push("Duplicate question IDs");
  const answers = new Map<string, Answer>();
  for (const answer of input.answers) {
    if (answers.has(answer.questionId)) blockers.push(`Duplicate answer: ${answer.questionId}`);
    if (!questions.has(answer.questionId)) blockers.push(`Unknown question: ${answer.questionId}`);
    answers.set(answer.questionId, answer.value);
  }
  const reviewed: ApplicationManifest["answers"] = [];
  for (const q of form.questions) {
    const value = answers.get(q.id);
    if (q.type === "unsupported") { blockers.push(`Unsupported question: ${q.label}`); continue; }
    if (q.condition) {
      const parent = questions.get(q.condition.questionId);
      if (!parent || parent.condition || parent.type === "multiple_choice" || parent.id === q.id) {
        blockers.push(`Unsupported question condition: ${q.label}`); continue;
      }
      if (answers.get(parent.id) !== q.condition.equals) {
        if (value !== undefined) blockers.push(`Answer supplied for inactive question: ${q.label}`);
        continue;
      }
    }
    const empty = value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
    if (empty) { if (q.required) blockers.push(`Missing answer: ${q.label}`); continue; }
    let valid = false;
    switch (q.type) {
      case "text": valid = typeof value === "string" && (q.maxLength === undefined || value.length <= q.maxLength); break;
      case "boolean": valid = typeof value === "boolean" && (!q.mustBeTrue || value === true); break;
      case "number": valid = typeof value === "number" && Number.isFinite(value) && (!q.integer || Number.isInteger(value - (q.min ?? 0))) && (q.min === undefined || value >= q.min) && (q.max === undefined || value <= q.max); break;
      case "single_choice": valid = typeof value === "string" && !!q.options?.some(option => option.id === value); break;
      case "multiple_choice": valid = Array.isArray(value) && new Set(value).size === value.length && value.every(id => q.options?.some(option => option.id === id)); break;
    }
    if (!valid) { blockers.push(`Invalid answer: ${q.label}`); continue; }
    const displayValue = q.options && (q.type === "single_choice" || q.type === "multiple_choice") ? (Array.isArray(value) ? value.map(id => q.options!.find(option => option.id === id)!.label) : q.options.find(option => option.id === value)!.label) : value!;
    reviewed.push({ questionId: q.id, question: q.label, value: structuredClone(value!), displayValue });
  }
  if (blockers.length) return { blockers };
  return { blockers, manifest: {
    kind: "application", accountKey: form.accountKey, accountLabel: form.accountLabel,
    jobId: form.jobId, title: form.title, employer: form.employer, term: form.term,
    deadline: form.deadline, formVersion: form.version, documents: selected,
    answers: reviewed, externalSteps: [...form.externalSteps],
  } };
}
