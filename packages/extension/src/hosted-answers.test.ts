import { expect, test } from "bun:test";
import { linkMissingFacts, renderAnswersStep } from "./hosted-answers.js";
import { withDom } from "./hosted-test-dom.js";

test("unsaved answers survive streamed refreshes, and edits open one answer at a time", () => withDom("<main></main>", (document, window) => {
  const job = { jobId: "draft-1", status: "review", resumeId: "resume", answers: [{ questionId: "eligible", value: true }], form: { questions: [
    { id: "experience", label: "Describe your experience", type: "text" as const, required: true },
    { id: "eligible", label: "Eligible to work?", type: "boolean" as const, required: true },
  ] }, missingFacts: ["Which project demonstrates this?"] };
  const first = renderAnswersStep(job); document.body.appendChild(first.element);
  const input = first.element.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Built a compiler"; input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const edit = first.element.querySelector<HTMLButtonElement>(".filled-answers button")!;
  expect(edit.getAttribute("aria-label")).toBe("Edit: Eligible to work?");
  edit.click();
  expect(first.element.querySelectorAll(".filled-answers select").length).toBe(1);
  const again = renderAnswersStep(job);
  expect(again.element.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Built a compiler");
  expect(again.element.querySelectorAll(".filled-answers select").length).toBe(1);
  expect(again.element.textContent).toContain("Which project demonstrates this?");
  expect(again.collect()).toBe("Answer the open questions above to continue.");
}));

test("question-linked missing facts appear as notes and follow-up comment boxes are labelled", () => withDom("<main></main>", () => {
  const step = renderAnswersStep({ jobId: "linked-1", status: "review", resumeId: "resume", answers: [{ questionId: "question_1", value: 3 }],
    form: { questions: [
      { id: "question_1", label: "Worked with large data?", type: "number", required: true },
      { id: "question_1_comment", label: "Worked with large data?", type: "text", required: false },
    ] },
    missingFacts: ["question_1: Confirm the dataset size.", "Which term are you available?"] });
  const text = step.element.textContent ?? "";
  expect(text).not.toContain("question_1:");
  expect(step.element.querySelector(".screening-note")!.textContent).toBe("Confirm the dataset size.");
  expect(text).toContain("Additional details for the question above");
  expect(step.element.querySelector(".step-heading")!.textContent).toBe("2 questions need you");
  const fact = [...step.element.querySelectorAll<HTMLTextAreaElement>(".open-questions textarea")].at(-1)!;
  fact.value = "Winter 2027";
  expect(step.collect()).toEqual({ answers: [{ questionId: "question_1", value: 3 }], factAnswers: [{ question: "Which term are you available?", value: "Winter 2027" }, { question: "question_1: Confirm the dataset size.", value: null }] });
}));

test("duplicate and question-linked missing facts are grouped once", () => {
  const questions = [{ id: "q1", label: "Notice", type: "text" as const, required: false }];
  const { linked, linkedFacts, open } = linkMissingFacts(questions, ["q1: How much notice?", "q1: How much notice?", "other: not a question", "Plain fact?", "Plain fact?"]);
  expect(linked.get("q1")).toEqual(["How much notice?"]);
  expect([...linkedFacts.keys()]).toEqual(["q1: How much notice?"]);
  expect(open).toEqual(["other: not a question", "Plain fact?"]);
});
