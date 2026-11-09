import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { linkMissingFacts, renderHostedQueue } from "./hosted-queue.js";

test("hosted confirmation renders readable manifest fields", () => {
  const dom = parseHTML("<main><div id='queue'></div></main>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  try {
    const queue = dom.document.querySelector("#queue") as unknown as HTMLElement;
    renderHostedQueue(queue, [{
      jobId: "123", status: "confirm_required", manifestHash: "a".repeat(64),
      manifest: { title: "Engineer", employer: "Example Co", term: "Fall 2027", deadline: "2027-08-30", documents: [{ label: "Resume", document: { name: "Resume.pdf", revision: "rev-1" } }], answers: [{ question: "Eligible?", displayValue: true }] },
      form: { questions: [{ id: "eligible", label: "Eligible to work?", type: "boolean", required: true }] },
    }], [], true, () => {}, () => {});
    const text = queue.textContent ?? "";
    for (const phrase of ["Review application details", "Engineer", "Example Co", "Fall 2027", "Resume.pdf", "Eligible?"]) expect(text).toContain(phrase);
    expect(text).not.toContain('"manifest"');
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("screening drafts survive streamed refreshes without an AI connection", () => {
  const dom = parseHTML("<main><div id='queue'></div></main>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  try {
    const queue = dom.document.querySelector("#queue") as unknown as HTMLElement;
    const job = {jobId:"draft-1",status:"review",resumeId:"resume",form:{questions:[{id:"experience",label:"Describe your experience",type:"text" as const,required:true}]},missingFacts:["Which project demonstrates this?"]};
    renderHostedQueue(queue,[job],[],false,()=>{},()=>{});
    const input = queue.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value="Built a compiler";
    input.dispatchEvent(new dom.window.Event("input", {bubbles:true}));
    renderHostedQueue(queue,[job],[],false,()=>{},()=>{});
    expect(queue.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Built a compiler");
    expect(queue.textContent).toContain("Which project demonstrates this?");
    expect(queue.textContent).toContain("Save answers and prepare application");
  } finally {
    if(previous)Object.defineProperty(globalThis,"document",previous);else Reflect.deleteProperty(globalThis,"document");
  }
});

test("resume and cover letter previews sit together in one documents section", () => {
  const dom = parseHTML("<main><div id='queue'></div></main>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  try {
    const queue = dom.document.querySelector("#queue") as unknown as HTMLElement;
    renderHostedQueue(queue, [{
      jobId: "docs-1", status: "cover_letter_review", resumeId: "resume", coverLetter: { sha256: "a", name: "letter.pdf", texKey: "letter.tex" },
      form: { requirements: [{ role: "attachment", typeId: "66", label: "Cover Letter" }] },
    }], [{ id: "resume", name: "Resume.pdf", size: 1 }], true, () => {}, () => {});
    const documents = queue.querySelector(".job-documents")!;
    const labels = [...documents.querySelectorAll("button")].map(item => item.textContent);
    expect(labels).toContain("Preview selected resume");
    expect(labels).toContain("Preview cover letter PDF");
    expect(documents.nextElementSibling!.classList.contains("job-actions")).toBe(true);
    renderHostedQueue(queue, [{ jobId: "docs-2", status: "submitted" }], [], true, () => {}, () => {});
    expect(queue.querySelector(".job-documents")).toBeNull();
  } finally {
    if(previous)Object.defineProperty(globalThis,"document",previous);else Reflect.deleteProperty(globalThis,"document");
  }
});

test("question-linked missing facts appear as notes, follow-up comment boxes are labelled, and no ID-only answer list renders", () => {
  const dom = parseHTML("<main><div id='queue'></div></main>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  try {
    const queue = dom.document.querySelector("#queue") as unknown as HTMLElement;
    renderHostedQueue(queue, [{
      jobId: "linked-1", status: "review", resumeId: "resume", answers: [{ questionId: "question_1", value: 3 }],
      form: { questions: [
        { id: "question_1", label: "Worked with large data?", type: "number", required: true },
        { id: "question_1_comment", label: "Worked with large data?", type: "text", required: false },
      ] },
      missingFacts: ["question_1: Confirm the dataset size.", "Which term are you available?"],
    }], [], true, () => {}, () => {});
    const text = queue.textContent ?? "";
    expect(text).not.toContain("Proposed answers");
    expect(text).not.toContain("question_1:");
    expect(queue.querySelector(".screening-note")!.textContent).toBe("Confirm the dataset size.");
    expect(text).toContain("Additional details for the question above");
    expect(queue.querySelectorAll("textarea").length).toBe(2);
    expect(text).toContain("We also need from you");
    expect(queue.querySelector(".screening-open")!.textContent).toBe("Answer screening questions (1/2 answered · 2 need you)");
    expect(queue.querySelector("dialog")!.hasAttribute("open")).toBe(false);
  } finally {
    if(previous)Object.defineProperty(globalThis,"document",previous);else Reflect.deleteProperty(globalThis,"document");
  }
});

test("duplicate and question-linked missing facts are grouped once", () => {
  const questions = [{ id: "q1", label: "Notice", type: "text" as const, required: false }];
  const { linked, linkedFacts, open } = linkMissingFacts(questions, ["q1: How much notice?", "q1: How much notice?", "other: not a question", "Plain fact?", "Plain fact?"]);
  expect(linked.get("q1")).toEqual(["How much notice?"]);
  expect([...linkedFacts.keys()]).toEqual(["q1: How much notice?"]);
  expect(open).toEqual(["other: not a question", "Plain fact?"]);
});
