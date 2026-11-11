import { factQuestionId } from "../../shared/src/missing-facts.js";
import type { HostedJob, ScreeningQuestion } from "./hosted-queue.js";

export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Not provided";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** Missing facts written as `questionId: note` belong under that question instead of a separate prompt. */
export function linkMissingFacts(questions: ScreeningQuestion[], facts: string[]): { linked: Map<string, string[]>; linkedFacts: Map<string, string>; open: string[] } {
  const ids = new Set(questions.map(question => question.id)), linked = new Map<string, string[]>(), linkedFacts = new Map<string, string>(), open: string[] = [];
  for (const fact of new Set(facts)) {
    const id = factQuestionId(fact, ids);
    if (id !== undefined) { linked.set(id, [...(linked.get(id) ?? []), fact.slice(fact.indexOf(":") + 1).trim()]); linkedFacts.set(fact, id); }
    else open.push(fact);
  }
  return { linked, linkedFacts, open };
}
/** WaterlooWorks pairs some choices with a comment box under the same label; show it as a follow-up. */
function questionTitle(question: ScreeningQuestion, previous?: ScreeningQuestion): string {
  return previous && question.type === "text" && previous.label.trim() === question.label.trim() ? "Additional details for the question above" : question.label;
}
export function displayAnswer(question: ScreeningQuestion | undefined, value: unknown): string {
  const option = (id: unknown) => question?.options?.find(item => item.id === id)?.label ?? String(id);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(option).join(", ");
  if (typeof value === "string" && question?.options) return option(value);
  return valueText(value);
}

/** Questions the user must look at: unanswered required ones, ones WatWorks flagged, and facts it could not find. */
function openItems(job: HostedJob): { questions: Set<string>; facts: string[]; linked: Map<string, string[]>; linkedFacts: Map<string, string> } {
  const questions = (job.form?.questions ?? []).filter(question => question.type !== "unsupported");
  const answered = new Set((job.answers ?? []).map(answer => answer.questionId));
  const { linked, linkedFacts, open } = linkMissingFacts(questions, job.missingFacts ?? []);
  return { questions: new Set(questions.filter(question => (question.required && !answered.has(question.id)) || linked.has(question.id)).map(question => question.id)), facts: open, linked, linkedFacts };
}
export function openAnswerCount(job: HostedJob): number { const items = openItems(job); return items.questions.size + items.facts.length; }

function questionEditor(question: ScreeningQuestion, initial: unknown, title: string, notes: string[] = []): { section: HTMLElement; read: () => unknown } {
  const section = document.createElement("label"), heading = document.createElement("span");
  section.className = "screening-question"; heading.className = "screening-label"; heading.textContent = title;
  if (!question.required) { const optional = document.createElement("span"); optional.className = "hint"; optional.textContent = " · optional"; heading.appendChild(optional); }
  section.appendChild(heading);
  // A note that only repeats the question adds nothing.
  const same = (note: string) => note.trim().replace(/[?.\s]+$/, "").toLowerCase() === question.label.trim().replace(/[?.\s]+$/, "").toLowerCase();
  for (const note of notes) { if (same(note)) continue; const hint = document.createElement("span"); hint.className = "screening-note"; hint.textContent = note; section.appendChild(hint); }
  const select = document.createElement("select"), input = document.createElement("input"), textarea = document.createElement("textarea");
  const blank = document.createElement("option"); blank.value = ""; blank.textContent = "Choose an answer";
  if (question.type === "text") {
    textarea.value = typeof initial === "string" ? initial : ""; textarea.rows = 3; if (question.maxLength !== undefined) textarea.maxLength = question.maxLength;
    textarea.setAttribute("aria-label", question.label); section.appendChild(textarea);
    return { section, read: () => textarea.value.trim() || undefined };
  }
  if (question.type === "number") {
    input.type = "number"; input.value = typeof initial === "number" ? String(initial) : ""; input.setAttribute("aria-label", question.label);
    if (question.min !== undefined) input.min = String(question.min); if (question.max !== undefined) input.max = String(question.max);
    input.step = "any"; section.appendChild(input);
    return { section, read: () => input.value === "" || !Number.isFinite(input.valueAsNumber) ? undefined : input.valueAsNumber };
  }
  if (question.type === "boolean") {
    select.appendChild(blank); const yes = document.createElement("option"), no = document.createElement("option");
    yes.value = "true"; yes.textContent = "Yes"; no.value = "false"; no.textContent = "No"; select.appendChild(yes); select.appendChild(no);
    select.value = typeof initial === "boolean" ? String(initial) : ""; select.setAttribute("aria-label", question.label); section.appendChild(select);
    return { section, read: () => select.value === "" ? undefined : select.value === "true" };
  }
  if (question.type === "single_choice") {
    select.appendChild(blank); for (const option of question.options ?? []) { const item = document.createElement("option"); item.value = option.id; item.textContent = option.label; select.appendChild(item); }
    select.value = typeof initial === "string" ? initial : ""; select.setAttribute("aria-label", question.label); section.appendChild(select);
    return { section, read: () => select.value || undefined };
  }
  const checks: Array<{ input: HTMLInputElement; id: string }> = [], selected = new Set(Array.isArray(initial) ? initial.filter((v): v is string => typeof v === "string") : []);
  for (const option of question.options ?? []) { const row = document.createElement("span"), check = document.createElement("input"), label = document.createElement("span"); check.type = "checkbox"; check.value = option.id; check.checked = selected.has(option.id); label.textContent = option.label; row.className = "check-option"; row.appendChild(check); row.appendChild(label); section.appendChild(row); checks.push({ input: check, id: option.id }); }
  return { section, read: () => { const values = checks.filter(item => item.input.checked).map(item => item.id); return values.length ? values : undefined; } };
}

interface AnswerDraft { answers: Map<string, unknown>; facts: Map<string, unknown>; editing: Set<string> }
/** Unsaved answers survive the re-renders driven by polling. */
const answerDrafts = new Map<string, AnswerDraft>();
export function clearAnswerDraft(jobId: string): void { answerDrafts.delete(jobId); }

export interface AnswersStep {
  element: HTMLElement;
  /** True when there is anything to save; otherwise approval needs no edited answers. */
  editable: boolean;
  /** The edited answers, or the reason they cannot be saved yet. */
  collect(): { answers: Array<{questionId: string; value: unknown}>; factAnswers: Array<{question: string; value: unknown}> } | string;
}

/**
 * Only the questions that need the user are open. Everything WatWorks filled in is a full,
 * readable question → answer list with an Edit link, because approving confirms all of it.
 */
export function renderAnswersStep(job: HostedJob, onChange: () => void = () => {}): AnswersStep {
  const questions = (job.form?.questions ?? []).filter(question => question.type !== "unsupported");
  const { questions: openIds, facts, linked, linkedFacts } = openItems(job);
  const answerById = new Map((job.answers ?? []).map(answer => [answer.questionId, answer.value]));
  const draft = answerDrafts.get(job.jobId) ?? { answers: new Map(), facts: new Map(), editing: new Set<string>() };
  const element = document.createElement("div"); element.className = "answers-step";
  const readers = new Map<string, () => unknown>(), factReaders: Array<{ question: string; read: () => unknown }> = [];
  const save = () => {
    for (const [id, read] of readers) draft.answers.set(id, read());
    for (const fact of factReaders) draft.facts.set(fact.question, fact.read());
    answerDrafts.set(job.jobId, draft); onChange();
  };
  element.addEventListener("input", save); element.addEventListener("change", save);
  const initial = (id: string) => draft.answers.has(id) ? draft.answers.get(id) : answerById.get(id);

  const openCount = openIds.size + facts.length;
  if (openCount) {
    const heading = document.createElement("h3"); heading.className = "step-heading";
    heading.textContent = `${openCount} ${openCount === 1 ? "question needs" : "questions need"} you`;
    element.appendChild(heading);
  }
  const open = document.createElement("div"); open.className = "open-questions";
  questions.forEach((question, index) => {
    if (!openIds.has(question.id)) return;
    const editor = questionEditor(question, initial(question.id), questionTitle(question, questions[index - 1]), linked.get(question.id));
    readers.set(question.id, editor.read); open.appendChild(editor.section);
  });
  facts.forEach((fact, index) => {
    const editor = questionEditor({ id: `fact-${index}`, label: fact, type: "text", required: true, maxLength: 5000 }, draft.facts.get(fact), fact);
    factReaders.push({ question: fact, read: editor.read }); open.appendChild(editor.section);
  });
  if (open.childElementCount) element.appendChild(open);

  const filled = questions.filter(question => !openIds.has(question.id));
  if (filled.length) {
    const label = document.createElement("p"); label.className = "filled-label"; label.textContent = "WatWorks filled in";
    const list = document.createElement("ul"); list.className = "filled-answers";
    filled.forEach(question => {
      const index = questions.indexOf(question), title = questionTitle(question, questions[index - 1]);
      const row = document.createElement("li");
      const showEditor = () => {
        const editor = questionEditor(question, initial(question.id), title);
        readers.set(question.id, editor.read); row.className = "editing"; row.replaceChildren(editor.section);
      };
      if (draft.editing.has(question.id)) { showEditor(); list.appendChild(row); return; }
      const qa = document.createElement("div"), q = document.createElement("span"), a = document.createElement("span"), edit = document.createElement("button");
      const value = initial(question.id), shown = value === undefined ? "Left blank" : displayAnswer(question, value);
      qa.className = "qa"; q.className = "q"; q.textContent = title; a.className = shown.length > 60 ? "a long" : "a"; a.textContent = shown;
      qa.append(q, a);
      edit.type = "button"; edit.className = "link"; edit.textContent = "Edit"; edit.setAttribute("aria-label", `Edit: ${title}`);
      edit.addEventListener("click", () => { draft.editing.add(question.id); answerDrafts.set(job.jobId, draft); showEditor(); row.querySelector<HTMLElement>("select, input, textarea")?.focus(); });
      row.append(qa, edit); list.appendChild(row);
    });
    element.append(label, list);
  }
  if (!questions.length && !facts.length) {
    const none = document.createElement("p"); none.className = "meta"; none.textContent = "This posting has no screening questions."; element.appendChild(none);
  }
  return {
    element,
    editable: questions.length > 0 || facts.length > 0 || linkedFacts.size > 0,
    collect() {
      const answers = questions.flatMap(question => {
        const read = readers.get(question.id), value = read ? read() : answerById.get(question.id);
        return value === undefined ? [] : [{ questionId: question.id, value }];
      });
      const missing = questions.filter(question => openIds.has(question.id) && question.required && !answers.some(answer => answer.questionId === question.id));
      const factAnswers: Array<{question: string; value: unknown}> = factReaders.map(fact => ({ question: fact.question, value: fact.read() }));
      if (missing.length || factAnswers.some(fact => !fact.value)) return "Answer the open questions above to continue.";
      // Question-linked facts are resolved by the linked answer itself, which is what gets remembered.
      for (const fact of linkedFacts.keys()) factAnswers.push({ question: fact, value: null });
      return { answers, factAnswers };
    },
  };
}
