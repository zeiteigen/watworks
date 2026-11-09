import type { ApplicationForm, ApplicationInput, ApplicationManifest, Answer } from "./types.js";

/** Shared screening validation for user edits and the final application manifest. */
export function validateAnswers(questionsInput: ApplicationForm["questions"], answersInput: ApplicationInput["answers"]): {blockers: string[]; answers: ApplicationManifest["answers"]} {
  const blockers: string[] = [];
  const questions = new Map(questionsInput.map(q => [q.id, q]));
  if (questions.size !== questionsInput.length) blockers.push("Duplicate question IDs");
  const answers = new Map<string, Answer>();
  for (const answer of answersInput) {
    if (answers.has(answer.questionId)) blockers.push(`Duplicate answer: ${answer.questionId}`);
    if (!questions.has(answer.questionId)) blockers.push(`Unknown question: ${answer.questionId}`);
    answers.set(answer.questionId, answer.value);
  }
  const reviewed: ApplicationManifest["answers"] = [];
  for (const q of questionsInput) {
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
  return {blockers, answers: reviewed};
}
