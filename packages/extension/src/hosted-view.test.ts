import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createHostedView } from "./hosted-view.js";
import type { HostedWorkspace } from "./hosted-client.js";

const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else Reflect.deleteProperty(globalThis, "document");
});
async function fixture() {
  const { document } = parseHTML(await Bun.file(`${import.meta.dir}/hosted.html`).text());
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const show = createHostedView(document as unknown as Document, () => {}, () => {});
  const workspace: HostedWorkspace = {
    profile: null, resumes: [], runs: [], ai: { available: true, connected: true, reason: "" },
    jobs: [
      { jobId: "101", status: "review", posting: { title: "Software engineer", organization: "Example Labs" } },
      { jobId: "102", status: "confirm_required", manifestHash: "a".repeat(64), manifest: { title: "Designer" }, posting: { title: "Designer", organization: "Example Studio" } },
      { jobId: "103", status: "submitted", posting: { title: "Analyst", organization: "Example Labs" } },
    ],
  };
  show(workspace);
  document.querySelector<HTMLElement>('[data-tab="jobs"]')!.click();
  return { document, show, workspace, click: (selector: string) => document.querySelector<HTMLElement>(selector)!.click() };
}

test("notebook tabs show the selected section and keep a single set of approval controls", async () => {
  const f = await fixture();
  expect(f.document.querySelector("#queue")!.textContent).toContain("Software engineer");
  expect(f.document.querySelector("#applications")!.children.length).toBe(0);
  expect(f.document.querySelectorAll(".job-confirm").length).toBe(1);
  f.click('[data-tab="applications"]');
  expect(f.document.querySelector<HTMLElement>("#jobs-panel")!.hidden).toBe(true);
  expect(f.document.querySelector<HTMLElement>("#applications-panel")!.hidden).toBe(false);
  expect(f.document.querySelector("#queue")!.children.length).toBe(0);
  expect(f.document.querySelector("#applications")!.textContent).not.toContain("Software engineer");
  expect(f.document.querySelector("#applications")!.textContent).not.toContain("Analyst");
  expect(f.document.querySelectorAll(".job-confirm").length).toBe(0);
  f.click('[data-tab="submitted"]');
  expect(f.document.querySelector("#submitted")!.textContent).toContain("Analyst");
  f.click('[data-tab="materials"]');
  expect(f.document.querySelector<HTMLElement>("#materials-panel")!.hidden).toBe(false);
  expect(f.document.querySelectorAll(".job-confirm").length).toBe(0);
  f.click('[data-tab="jobs"]');
  expect(f.document.querySelector('[data-tab="jobs"]')!.getAttribute("aria-current")).toBe("page");
  expect(f.document.querySelectorAll(".job-confirm").length).toBe(1);
});

test("job search and status filters persist when streamed workspace results arrive", async () => {
  const f = await fixture();
  const search = f.document.querySelector<HTMLInputElement>("#job-search")!;
  search.value = "example labs";
  search.dispatchEvent(new f.document.defaultView!.Event("input"));
  expect(f.document.querySelectorAll("#queue .job-card").length).toBe(1);
  f.click('[data-queue-filter="review"]');
  expect(f.document.querySelectorAll("#queue .job-card").length).toBe(1);
  expect(f.document.querySelector("#queue-count")!.textContent).toBe("1 job");
  f.show({ ...f.workspace, jobs: [...f.workspace.jobs, { jobId: "104", status: "review", posting: { title: "Developer", organization: "Example Labs" } }] });
  // New arrivals wait behind a banner instead of shifting the queue under the reader.
  expect(f.document.querySelectorAll("#queue .job-card").length).toBe(1);
  expect(f.document.querySelector<HTMLElement>("#new-jobs")!.hidden).toBe(false);
  expect(f.document.querySelector("#new-jobs")!.textContent).toBe("1 new match · Show");
  f.click("#new-jobs");
  expect(f.document.querySelector<HTMLElement>("#new-jobs")!.hidden).toBe(true);
  expect(f.document.querySelectorAll("#queue .job-card").length).toBe(2);
  expect(f.document.querySelector('[data-queue-filter="review"]')!.getAttribute("aria-pressed")).toBe("true");
  search.value = "no match";
  search.dispatchEvent(new f.document.defaultView!.Event("input"));
  expect(f.document.querySelector("#queue")!.textContent).toBe("No jobs match these filters.");
});

test("setup links reach settings and materials without launching authentication or applications", async () => {
  const f = await fixture();
  expect(f.document.querySelector<HTMLElement>("#setup-notice")!.hidden).toBe(false);
  f.click('[data-open-tab="settings"]');
  expect(f.document.querySelector<HTMLElement>("#onboarding-panel")!.hidden).toBe(false);
  f.click('[data-open-tab="materials"]');
  expect(f.document.querySelector<HTMLElement>("#materials-panel")!.hidden).toBe(false);
});


test("first launch opens profile onboarding and prompts ChatGPT connection", async () => {
  const f = await fixture();
  const { document } = f;
  const show = createHostedView(document as unknown as Document, () => {}, () => {});
  show(f.workspace);
  expect(document.querySelector<HTMLElement>("#onboarding-panel")!.hidden).toBe(false);
  expect(document.querySelector("#onboarding-fields #profile-form")).not.toBeNull();
  expect(document.querySelector('[name="workTerm"]')).toBeNull();
  expect(document.querySelector('[name="eightMonthEligible"]')).not.toBeNull();
  expect(document.querySelector("#chatgpt-connect")).not.toBeNull();
});

test("review combines uncertain outcomes; progress and successful submissions stay separate", async () => {
  const f = await fixture();
  f.show({...f.workspace, jobs: [...f.workspace.jobs,
    {jobId:"104",status:"uncertain",posting:{title:"Check outcome"}},
    {jobId:"105",status:"submitting",posting:{title:"Sending now"}},
    {jobId:"106",status:"dismissed",posting:{title:"Removed"}},
  ]});
  f.click("#new-jobs");
  f.click('[data-queue-filter="review"]');
  expect(f.document.querySelector("#queue")!.textContent).toContain("Check outcome");
  expect(f.document.querySelector("#queue")!.textContent).not.toContain("Sending now");
  expect(f.document.querySelector("#queue")!.textContent).not.toContain("Removed");
  f.click('[data-tab="applications"]');
  expect(f.document.querySelector("#applications")!.textContent).toContain("Sending now");
  expect(f.document.querySelector("#applications")!.textContent).not.toContain("Check outcome");
  f.click('[data-tab="submitted"]');
  expect(f.document.querySelector("#submitted")!.textContent).toContain("Analyst");
  expect(f.document.querySelector("#submitted")!.textContent).not.toContain("Sending now");
});

test("refreshes wait while a job dialog is open and apply when it closes", async () => {
  const f = await fixture();
  f.click("#queue .job-actions button");
  const dialog = f.document.querySelector<HTMLDialogElement>("#queue dialog")!;
  expect(dialog.hasAttribute("open")).toBe(true);
  f.show({ ...f.workspace, jobs: f.workspace.jobs.map(job => job.jobId === "101" ? { ...job, posting: { title: "Renamed engineer" } } : job) });
  expect(f.document.querySelector("#queue")!.textContent).not.toContain("Renamed engineer");
  dialog.querySelector<HTMLButtonElement>(".job-dialog-heading button")!.click();
  expect(f.document.querySelector("#queue")!.textContent).toContain("Renamed engineer");
});

test("a posting requested by ID is not held behind the new-match banner", async () => {
  const f = await fixture();
  f.show.reveal("200");
  f.show({ ...f.workspace, jobs: [...f.workspace.jobs, { jobId: "200", status: "review", posting: { title: "Requested posting" } }] });
  expect(f.document.querySelector("#queue")!.textContent).toContain("Requested posting");
  expect(f.document.querySelector<HTMLElement>("#new-jobs")!.hidden).toBe(true);
});
