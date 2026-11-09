import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { DASHBOARD_PAGE, DASHBOARD_SCRIPT } from "./page.js";

async function viewer(initialState = "ready", reason?:string, submission?:{connected:boolean;authenticated:boolean;fillOnly:boolean;error?:string}, options:{localhostPage?:boolean;attachments?:unknown[];fakeEventSource?:boolean;email?:string|null;insider?:boolean;term?:string|null;admin?:boolean;reason?:string} = {}) {
  const account=typeof options.insider==='boolean'?options:undefined;
  const { document, window } = parseHTML(DASHBOARD_PAGE);
  const job = {
    key: "waterlooworks:123", summary: { jobId: "123", title: "Developer", employer: "Acme", location: "Toronto" },
    status: { state: initialState, reason, blockers: [], externalSteps: [], removedFromQueueAt: undefined as string | undefined },
    active: false, caveats: [], rank: 12, resumeVariant: "swe", documents: [{ kind: "cover_letter", id: "letter", title: "Cover letter" }], approvalHash: "test-hash", reviewHash: "content-hash",
    manualApply: { url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm", hint: "Open posting 123 in WaterlooWorks" },
  };
  const applications: Array<{applicationId:string;jobId:string;title:string;employer:string;location:string;term:string;status:string|null;jobStatus?:string;submittedAt:string}> = [];
  const writes: string[] = [];
  const preparations: string[] = [];
  const mints: Array<[string,string]> = [];
  const planAttachments = options.attachments ?? [];
  const bodies: unknown[] = [];
  const timers: Array<{callback:()=>unknown;delay:number}> = [];
  const eventSources: Array<{url:string;onmessage?:((event:{data:string})=>void)|null;onerror?:(()=>void)|null;closed:boolean;close():void}> = [];
  let stateReads = 0;
  let refuseRemoval = false;
  const intervals = new Map<number, () => void>();
  let nextInterval = 0;
  let failPreparation = false;
  let preparationGate: Promise<void> | undefined;
  let applyGate: Promise<void> | undefined;
  class FakeEventSource {
    onmessage: ((event:{data:string})=>void)|null = null;
    onerror: (()=>void)|null = null;
    closed = false;
    constructor(readonly url:string) { eventSources.push(this); }
    close() { this.closed = true; }
  }
  runInNewContext(DASHBOARD_SCRIPT, {
    document, URL,
    setTimeout: (callback:()=>unknown,delay=0) => { timers.push({callback,delay}); return timers.length; }, clearTimeout: () => {},
    setInterval: (callback: () => void) => { intervals.set(++nextInterval, callback); return nextInterval; }, clearInterval: (id:number) => { intervals.delete(id); },
    hasInsiderAccount: async () => false,
    ...(options.localhostPage ? {} : {mintWriteApproval:async(action:string,target:string)=>{mints.push([action,target]);return "minted-token";}}),
    getInsiderAccount: account ? async () => account : undefined,
    submissionDeveloperModeEnabled: () => document.documentElement.hasAttribute('data-submission-developer-mode'),
    createSubmissionSettingsPanel: () => { const panel = document.createElement('section'); panel.id = 'test-submission-settings'; return panel; },
    ...(options.fakeEventSource ? {EventSource:FakeEventSource} : {}),

    fetch: async (path: string, options: { method: string; body?: string }) => {
      if (path === "/api/applications") return Response.json({checkedAt:"2026-11-04T12:00:00Z",applications});
      if (path === "/api/state") { stateReads++; return Response.json({ jobs: [job], health: { authenticated: true, bridgeConnected: true },submission }); }
      if (path === "/api/submission/prepare" && options.method === "POST") {
        preparations.push(path);
        await preparationGate;
        return failPreparation ? Response.json({ error: "WaterlooWorks sign-in required" }, { status: 400 }) : Response.json({ prepared: true });
      }
      if (path === "/api/jobs/waterlooworks/123" && options.method === "GET") return Response.json({
        description: "# Developer\n\n## Responsibilities\n\nFull responsibilities and qualifications. <script>unsafe()</script>\n\n- Build products\n- **Test** changes",
        postingRequiredDocuments: ["Resume", "Cover letter"],
        requirements: [{ label: "Resume", required: true }, { label: "Portfolio", required: false }],
        questions: [{ label: "Eligible?", required: true, options: [{ label: "Yes" }, { label: "No" }] }],
        formBlockers: [], answers: [], attachments: planAttachments, externalSteps: ["Email recruiter"],
      });
      if (path.includes("/files/") || path.includes("/attachments/")) return new Response(new Blob(["fixture-pdf"], { type: "application/pdf" }), { headers: { "content-type": "application/pdf" } });
      if (options.method === "POST") {
        writes.push(path);
        bodies.push(JSON.parse(options.body ?? "{}"));
        if (refuseRemoval) return Response.json({ error: "Already submitting" }, { status: 409 });
        if (path.endsWith("/apply")) { await applyGate; job.active = true; job.status.state = "applying"; }
        if (path.endsWith("/recover")) { job.status.state = "ready"; return Response.json({ status: job.status }); }
        job.status.removedFromQueueAt = path.endsWith("/remove") ? new Date().toISOString() : undefined;
        return Response.json({});
      }
      throw Error("Unexpected route " + path);
    },
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const button = (text: string) => Array.from(document.querySelectorAll("button")).find(node => node.textContent === text)!;
  const view = async (value: string) => {
    const select = document.getElementById("queue-filter")!;
    for (const option of select.querySelectorAll("option")) option.selected = option.value === value;
    select.dispatchEvent(new window.Event("change"));
    await settle();
  };
  await settle();
  return { mints, holdPreparation: () => { let release!:()=>void; preparationGate = new Promise<void>(resolve => { release = resolve; }); return release; }, holdApply: () => { let release!:()=>void; applyGate = new Promise<void>(resolve => { release = resolve; }); return release; }, tickDelay: (seconds = 5) => { for (let i = 0; i < seconds; i++) for (const callback of [...intervals.values()]) callback(); }, get intervalCount(){return intervals.size;}, document, window, job, applications, writes, preparations, bodies, timers, eventSources, get stateReads(){return stateReads;}, button, view, settle, refuse: () => { refuseRemoval = true; }, failPreparation: () => { failPreparation = true; } };

}

describe("job viewer", () => {
  test("account status updates automatically when an admin grant is recognized", async () => {
    const account = {email:"member@uwaterloo.ca",insider:false};
    const ui = await viewer("ready", undefined, undefined, account);
    expect(ui.document.querySelector(".plan-label")?.textContent).toBe("Core");
    expect(ui.document.getElementById("insider-nudge")!.hidden).toBe(false);
    expect(ui.document.body.textContent).not.toContain("The job queue");
    expect(ui.button("Check Insider access")).toBeUndefined();
    account.insider = true;
    ui.document.dispatchEvent(new ui.window.Event("insider-account-changed"));
    await ui.settle();
    expect(ui.document.querySelector(".plan-label")?.textContent).toBe("Insider");
    expect(ui.document.getElementById("insider-nudge")!.hidden).toBe(true);
    expect(ui.button("Auto-apply")).toBeUndefined();
    expect(ui.document.getElementById("apply-bar")!.hasAttribute("hidden")).toBe(false);
    expect(ui.preparations).toEqual([]);
    expect(ui.writes).toEqual([]);
  });

  test("hides server application controls for a known Core account", async () => {
    const ui = await viewer("ready", undefined, undefined, { email: "ww@example.edu", insider: false, term: null, admin: false });
    expect(ui.document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(ui.document.getElementById("apply-bar")?.hasAttribute("hidden")).toBe(true);
    expect(ui.document.getElementById("account-plan")?.textContent).toContain("Core");
    const nudge = ui.document.getElementById("insider-nudge")!;
    expect(nudge.hidden).toBe(false);
    expect(nudge.textContent).toContain("after your approval");
    expect(nudge.textContent).toContain("Also: Core opens manual applications after a 5-second wait");
    expect(nudge.querySelector('a')?.getAttribute('href')).toBe('https://watworks.alishahzad.dev/#insider');
    expect(ui.document.getElementById("account-plan")?.textContent).toContain("ww@example.edu");
    expect((ui.document.getElementById("apply") as HTMLButtonElement).disabled).toBe(true);
    expect(ui.document.querySelector(".premium-tag")?.textContent).toBe("INSIDER");
    expect(ui.document.querySelector('input[type="password"]')).toBeNull();
    const autoApply = ui.button("Auto-apply") as HTMLButtonElement;
    expect(autoApply.disabled).toBe(true);
    expect(autoApply.title).toBe('Reserved for Insiders');
    expect(autoApply.getAttribute('aria-label')).toContain('requires Insider');
  });
  test("Core accounts hide submission health and settings and keep manual application available", async () => {
    const ui = await viewer("ready", undefined, {connected:false,authenticated:false,fillOnly:true}, {email:"free@example.edu",insider:false});
    expect(ui.document.getElementById("health")!.textContent).not.toContain("Submission");
    expect(ui.document.getElementById("status")!.textContent).toContain("apply manually");
    expect(ui.document.getElementById("status")!.textContent).not.toContain("server");
    ui.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click();
    await ui.settle();
    expect(ui.document.getElementById("settings-panel")!.textContent).toBe("No settings available for your plan.");
    ui.document.querySelector<HTMLButtonElement>('[data-tab="jobs"]')!.click();
    ui.button("View in detail").click();
    await ui.settle();
    ui.button("Apply manually in WaterlooWorks ↗").click();
    await ui.settle();
    ui.tickDelay();
    await ui.settle();
    expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/open-application-form"]);
    expect(ui.preparations).toEqual([]);
  });
  test("Core can reveal endpoint settings through developer mode without unlocking submissions", async () => {
    const ui = await viewer("ready", undefined, undefined, {insider:false});
    ui.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click();
    await ui.settle();
    expect(ui.document.querySelector('#test-submission-settings')).toBeNull();
    ui.document.documentElement.setAttribute('data-submission-developer-mode', '');
    ui.document.dispatchEvent(new ui.window.Event('submission-developer-mode-changed'));
    await ui.settle();
    expect(ui.document.querySelector('#test-submission-settings')).not.toBeNull();
    expect(ui.document.getElementById('apply-bar')!.hidden).toBe(true);
    expect(ui.preparations).toEqual([]);
    expect(ui.writes).toEqual([]);
  });
  test("account changes remove previously visible server controls and settings", async () => {
    const account = {email:"member@example.edu",insider:true};
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:false}, account);
    expect(ui.document.getElementById("apply-bar")!.hasAttribute("hidden")).toBe(false);
    ui.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click();
    await ui.settle();
    account.insider = false;
    ui.document.dispatchEvent(new ui.window.Event("insider-account-changed"));
    await ui.settle();
    expect(ui.document.getElementById("health")!.textContent).not.toContain("Submission");
    expect(ui.document.getElementById("settings-panel")!.textContent).toBe("No settings available for your plan.");
    ui.document.querySelector<HTMLButtonElement>('[data-tab="jobs"]')!.click();
    expect(ui.document.getElementById("apply-bar")!.hasAttribute("hidden")).toBe(true);
    expect(ui.document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(ui.preparations).toEqual([]);
  });
  test("shows Insider status without gating server applications", async () => {
    const ui = await viewer("ready", undefined, undefined, { email: "member@example.edu", insider: true, term: "Fall 2026", admin: false });
    const checkbox = ui.document.querySelector('input[type="checkbox"]')! as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new ui.window.Event("change"));
    expect(ui.document.getElementById("account-plan")?.textContent).toContain("Insider");
    expect((ui.document.getElementById("apply") as HTMLButtonElement).disabled).toBe(false);
  });
  test("shows the current browser phase prominently on the card and page status", async () => {
    const ui = await viewer("applying", "Uploading cover letter");
    await ui.view("queue");
    Array.from(ui.document.querySelectorAll<HTMLButtonElement>('#queue-tabs button')).find(button => button.textContent?.startsWith("In progress"))!.click();
    const phase = ui.document.querySelector('.phase');
    expect(phase?.textContent).toBe("Uploading cover letter");
    expect(phase?.getAttribute('role')).toBe('status');
    expect(phase?.getAttribute('aria-live')).toBe('polite');
    expect(ui.document.getElementById('status')?.textContent).toBe("Uploading cover letter");
    expect(ui.writes).toEqual([]);
  });
  test("uses one application event stream while applying and refreshes once on terminal status", async () => {
    const ui = await viewer("applying", "Starting application", undefined, {fakeEventSource:true});
    expect(ui.eventSources).toHaveLength(1);
    expect(ui.eventSources[0]!.url).toBe("/api/application-events");
    expect(ui.eventSources[0]!.closed).toBe(false);
    expect(ui.stateReads).toBe(1);
    ui.eventSources[0]!.onmessage!({data:JSON.stringify({jobs:[{key:ui.job.key,status:{state:"applying",reason:"Uploading cover letter",blockers:[],externalSteps:[]},active:true}]})});
    await ui.settle();
    expect(ui.document.getElementById("status")!.textContent).toBe("Uploading cover letter");
    expect(ui.stateReads).toBe(1);
    ui.job.status = {...ui.job.status,state:"form_filled",reason:"Form filled.",blockers:[],externalSteps:[]};
    ui.eventSources[0]!.onmessage!({data:JSON.stringify({jobs:[{key:ui.job.key,status:{state:"form_filled",reason:"Form filled.",blockers:[],externalSteps:[]},active:false}]})});
    await ui.settle();
    expect(ui.eventSources[0]!.closed).toBe(true);
    expect(ui.stateReads).toBe(2);
    expect(ui.writes).toEqual([]);
  });
  test("event stream disconnect schedules only a read reconnect and no application write", async () => {
    const ui = await viewer("applying", "Starting application", undefined, {fakeEventSource:true});
    ui.eventSources[0]!.onerror!();
    await ui.settle();
    expect(ui.eventSources[0]!.closed).toBe(true);
    expect(ui.writes).toEqual([]);
    expect(ui.timers.map(timer=>timer.delay)).toEqual([5000]);
    expect(ui.timers.some(timer=>timer.delay===1500)).toBe(false);
  });
  for (const insider of [false, true]) {
    for (const state of ["ready", "planned", "found"]) {
      test(`${insider ? "Insider" : "Core"} can apply manually from a collapsed ${state} card`, async () => {
        const ui = await viewer(state, undefined, undefined, {insider, email:"student@example.edu"});
        if (state !== "ready") {
          Array.from(ui.document.querySelectorAll<HTMLButtonElement>('#queue-tabs button')).find(button => button.textContent?.startsWith("Needs attention"))!.click();
          await ui.settle();
        }
        expect(ui.document.querySelector(".details")!.hasAttribute("hidden")).toBe(true);
        expect(ui.document.querySelector(".job-footer")!.textContent).toContain("Apply manually in WaterlooWorks");
        const manual = ui.button("Apply manually in WaterlooWorks ↗") as HTMLButtonElement;
        expect(manual.disabled).toBe(false);
        manual.click();
        await ui.settle();
        if (!insider) {
          expect(ui.writes).toEqual([]);
          expect(manual.textContent).toContain("opens in 5s");
          expect(manual.textContent).toContain("Core plan");
          ui.tickDelay();
          await ui.settle();
        }
        expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/open-application-form"]);
        expect(ui.preparations).toEqual([]);
        ui.button("View in detail").click();
        await ui.settle();
        expect(Array.from(ui.document.querySelectorAll("button")).filter(button => button.textContent?.startsWith("Apply manually in WaterlooWorks"))).toHaveLength(1);
      });
    }
  }
  test("manual apply asks the extension to open the selected posting", async () => {
    const ui = await viewer("planned");
    await ui.view("queue");
    Array.from(ui.document.querySelectorAll<HTMLButtonElement>('#queue-tabs button')).find(button => button.textContent?.startsWith("Needs attention"))!.click();
    ui.button("View in detail").click();
    await ui.settle();
    expect(ui.document.querySelector(".job-footer")?.textContent).toContain("Apply manually in WaterlooWorks ↗");
    ui.button("Apply manually in WaterlooWorks ↗").click();
    await ui.settle();
    ui.tickDelay();
    await ui.settle();
    expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/open-application-form"]);
    expect(ui.document.getElementById("status")!.textContent).toBe("Opened application form for posting 123 in WaterlooWorks.");
  });

  test("first Apply prepares the session and refreshes state before arming approval", async () => {
    const ui = await viewer();
    // DOM implementations may expose an unselected mode as an empty string.
    Object.defineProperty(ui.document.getElementById("application-mode")!, "value", { get: () => "" });
    ui.document.getElementById("select-all")!.click();
    ui.document.getElementById("apply")!.click();
    await ui.settle();
    expect(ui.preparations).toEqual(["/api/submission/prepare"]);
    expect(ui.writes).toEqual([]);
    expect(ui.bodies).toEqual([]);
    expect(ui.document.getElementById("apply")!.textContent).toContain("Click again to submit");
    ui.document.getElementById("apply")!.click();
    await ui.settle();
    expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/apply"]);
    expect(ui.bodies).toEqual([{ approvalHash: "test-hash", approval: "minted-token" }]);
    expect(ui.mints).toEqual([["apply", "waterlooworks:123"]]);
  });

  test("ready sessions confirm immediately without repeating session preparation", async () => {
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:true});
    ui.document.getElementById("select-all")!.click();
    const apply = ui.document.getElementById("apply")!;
    const reads = ui.stateReads;
    apply.click();
    expect(apply.textContent).toContain("Click again to submit");
    expect(ui.stateReads).toBe(reads);
    expect(ui.preparations).toEqual([]);
    expect(ui.writes).toEqual([]);
    // An unrelated state refresh preserves this explicit confirmation.
    ui.job.status.reason = "Ready for review";
    await ui.timers.find(timer => timer.delay === 15000)!.callback();
    await ui.settle();
    expect(apply.textContent).toContain("Click again to submit");
    expect(ui.timers.some(timer => timer.delay === 4000)).toBe(false);
    const release = ui.holdApply();
    apply.click();
    apply.click();
    await ui.settle();
    expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/apply"]);
    const firstTab = ui.document.querySelector('#queue-tabs button')!;
    expect(firstTab.textContent).toBe("In progress (1)");
    expect(firstTab.getAttribute('aria-selected')).toBe('true');
    expect(ui.document.getElementById('groups')!.textContent).toContain('Starting application');
    release();
    await ui.settle();
    expect(ui.writes).toHaveLength(1);
    expect(ui.document.querySelector('#queue-tabs [aria-selected="true"]')!.textContent).toBe("In progress (1)");
  });

  test("slow preparation remains disabled through polling and repeated clicks", async () => {
    const ui = await viewer();
    const release = ui.holdPreparation();
    ui.document.getElementById("select-all")!.click();
    const apply = ui.document.getElementById("apply") as HTMLButtonElement;
    apply.click();
    await ui.settle();
    expect(apply.disabled).toBe(true);
    expect(apply.textContent).toBe("Connecting submission session…");
    await ui.timers.find(timer => timer.delay === 15000)!.callback();
    await ui.settle();
    expect(apply.disabled).toBe(true);
    apply.click();
    await ui.settle();
    expect(ui.preparations).toHaveLength(1);
    expect(ui.writes).toEqual([]);
    release();
    await ui.settle();
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toContain("Click again to submit");
    expect(ui.preparations).toHaveLength(1);
  });

  test("changing reviewed application content invalidates confirmation", async () => {
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:true});
    ui.document.getElementById("select-all")!.click();
    ui.document.getElementById("apply")!.click();
    ui.job.approvalHash = "updated-documents";
    await ui.timers.find(timer => timer.delay === 15000)!.callback();
    await ui.settle();
    expect(ui.document.getElementById("apply")!.textContent).not.toContain("Click again");
    expect(ui.writes).toEqual([]);
  });

  test("a job that changes after selection is deselected with a notice and never sent", async () => {
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:true});
    ui.document.getElementById("select-all")!.click();
    ui.document.getElementById("apply")!.click();
    ui.job.reviewHash = "agent-rewrote-the-letter";
    ui.job.approvalHash = "agent-rewrote-the-letter-bound";
    await ui.timers.find(timer => timer.delay === 15000)!.callback();
    await ui.settle();
    expect(ui.document.getElementById("apply-count")!.textContent).toContain("0 of 1 selected");
    expect(ui.document.getElementById("status")!.textContent).toContain("changed after you reviewed it");
    ui.document.getElementById("apply")!.click();
    await ui.settle();
    expect(ui.writes).toEqual([]);
  });

  test("a job that changes after its details were opened warns even before it is selected", async () => {
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:true});
    ui.button("View in detail").click();
    await ui.settle();
    ui.job.reviewHash = "changed";
    await ui.timers.find(timer => timer.delay === 15000)!.callback();
    await ui.settle();
    expect(ui.document.getElementById("status")!.textContent).toContain("changed after you reviewed it");
  });

  test("session binding changes alone do not count as a changed review", async () => {
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:true});
    ui.document.getElementById("select-all")!.click();
    ui.job.approvalHash = "bound-to-a-new-session";
    await ui.timers.find(timer => timer.delay === 15000)!.callback();
    await ui.settle();
    expect(ui.document.getElementById("apply-count")!.textContent).toContain("1 of 1 selected");
    expect(ui.document.getElementById("status")!.textContent).not.toContain("changed after");
  });

  test("the localhost page explains that writes need the extension dashboard", async () => {
    const ui = await viewer("ready", undefined, {connected:true,authenticated:true,fillOnly:true}, {localhostPage:true});
    ui.document.getElementById("select-all")!.click();
    ui.document.getElementById("apply")!.click();
    await ui.settle();
    expect(ui.document.getElementById("apply")!.textContent).not.toContain("Click again");
    expect(ui.document.getElementById("status")!.textContent).toContain("extension dashboard");
    expect(ui.writes).toEqual([]);
  });

  test("shows and previews each attachment the plan will submit", async () => {
    const ui = await viewer("ready", undefined, undefined, {attachments:[{requirementId:"slot 1",kind:"file",label:"Portfolio",name:"portfolio.pdf"}]});
    ui.button("View in detail").click();
    await ui.settle();
    expect(ui.document.body.textContent).toContain("Portfolio: portfolio.pdf (your file)");
    expect(ui.button("View attachment: Portfolio (portfolio.pdf)")).toBeDefined();
  });

  test("In progress is first while processing and disappears on completion", async () => {
    const ui = await viewer("applying", undefined, undefined, {fakeEventSource:true});
    expect(ui.document.querySelector('#queue-tabs button')!.textContent).toBe("In progress (1)");
    ui.document.querySelector<HTMLButtonElement>('#queue-tabs button')!.click();
    const stream = ui.eventSources[0]!;
    stream.onmessage!({data:JSON.stringify({jobs:[{key:ui.job.key,status:{...ui.job.status,state:'applied'},active:false}]})});
    ui.job.status.state = 'applied';
    await ui.settle();
    expect(ui.document.getElementById('queue-tabs')!.textContent).not.toContain('In progress');
    expect(ui.document.querySelector('#queue-tabs [aria-selected="true"]')!.textContent).toContain('Ready to apply');
  });

  test("failed preparation blocks submission and leaves the selection available", async () => {
    const ui = await viewer();
    ui.document.getElementById("select-all")!.click();
    ui.failPreparation();
    ui.document.getElementById("apply")!.click();
    await ui.settle();
    expect(ui.preparations).toEqual(["/api/submission/prepare"]);
    expect(ui.writes).toEqual([]);
    expect(ui.bodies).toEqual([]);
    expect(ui.document.getElementById("status")!.textContent).toContain("WaterlooWorks sign-in required");
    expect(ui.document.getElementById("apply-count")!.textContent).toContain("1 of 1 selected");
  });

  test("removes selected jobs, clears selection, and restores from Removed jobs", async () => {
    const ui = await viewer();
    const checkbox = ui.document.querySelector('input[type="checkbox"]')! as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new ui.window.Event("change"));
    expect(ui.document.getElementById("apply-count")!.textContent).toBe("1 of 1 selected");
    ui.button("Remove from queue").click();
    await ui.settle();
    expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(0);
    expect(ui.document.getElementById("apply-bar")!.hasAttribute("hidden")).toBe(true);
    expect(ui.document.getElementById("status")!.textContent).toContain("Removed Developer");
    await ui.view("removed");
    expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
    expect(ui.document.querySelector('input[type="checkbox"]')).toBeNull();
    ui.button("Restore to queue").click();
    await ui.settle();
    await ui.view("queue");
    expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
    expect(ui.document.getElementById("apply-count")!.textContent).toBe("0 of 1 selected");
    expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/remove", "/api/jobs/waterlooworks/123/requeue"]);
  });

  test("filters jobs and keeps removal errors visible", async () => {
    const ui = await viewer();
    const search = ui.document.getElementById("job-search")! as HTMLInputElement;
    search.value = "no-match";
    search.dispatchEvent(new ui.window.Event("input"));
    expect(ui.document.getElementById("groups")!.textContent).toContain("No matching jobs");
    search.value = "toronto";
    search.dispatchEvent(new ui.window.Event("input"));
    expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
    ui.refuse();
    ui.button("Remove from queue").click();
    await ui.settle();
    expect(ui.document.getElementById("status")!.textContent).toBe("Already submitting");
    expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
  });
});

test("extension dashboard loads offline, uses native discovery, and recovers an empty queue", async () => {
  const { document } = parseHTML(DASHBOARD_PAGE);
  let offline = true;
  let poll: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  runInNewContext(DASHBOARD_SCRIPT, {
    document, URL,
    setTimeout: (callback: () => Promise<void>) => { poll = callback; return 1; }, clearTimeout: () => {},
    dashboardRequest: async (path: string) => {
      calls.push(path);
      if (path === "/api/state") return { jobs: [], workspaceOffline: offline, health: { authenticated: true, bridgeConnected: true } };
      if (path === "/api/discoveries") return { discoveries: [{ id: "123", title: "Developer", score: 2, reasons: ["Title matched"] }] };
      throw Error("Unexpected request " + path);
    },
    fetch: () => { throw Error("Extension UI must use its data adapter"); },
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await settle();
  expect(document.getElementById("status")!.textContent).toContain("Workspace service is offline");
  expect(document.getElementById("groups")!.textContent).toContain("unavailable");
  expect(document.getElementById("apply-bar")!.hasAttribute("hidden")).toBe(true);
  (document.querySelector('[data-tab="discoveries"]')! as unknown as HTMLButtonElement).click();
  await settle();
  expect(document.getElementById("discoveries-panel")!.textContent).toContain("Developer");
  offline = false;
  await poll!();
  await settle();
  expect(document.getElementById("status")!.textContent).toContain("0 jobs in your queue");
  expect(document.getElementById("groups")!.textContent).toContain("A new page awaits");
  expect(calls).toEqual(["/api/state", "/api/discoveries", "/api/discovery-status", "/api/state"]);
});

test("Materials recovers after workspace startup without changing tabs", async () => {
  const { document } = parseHTML(DASHBOARD_PAGE);
  let offline = true;
  let poll: (() => Promise<void>) | undefined;
  let materialReads = 0;
  runInNewContext(DASHBOARD_SCRIPT, {
    document, URL,
    setTimeout: (callback: () => Promise<void>) => { poll = callback; return 1; }, clearTimeout: () => {},
    dashboardRequest: async (path: string) => {
      if (path === "/api/state") return { jobs: [], workspaceOffline: offline, health: { authenticated: true, bridgeConnected: true } };
      if (path === "/api/materials") {
        materialReads++;
        if (offline) throw Error("Workspace service is offline");
        return { resumes: [{ id: "swe", label: "Software engineering", available: true }], documents: [] };
      }
      throw Error("Unexpected route " + path);
    },
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await settle();
  (document.querySelector('[data-tab="materials"]')! as unknown as HTMLButtonElement).click();
  await settle();
  expect(document.getElementById("materials-panel")!.textContent).toContain("offline");
  expect(document.getElementById("materials-panel")!.textContent).toContain("Retry connection");
  offline = false;
  await poll!();
  await settle();
  expect(document.getElementById("materials-panel")!.textContent).toContain("Software engineering");
  expect(document.getElementById("materials-panel")!.textContent).not.toContain("offline");
  expect(materialReads).toBe(2);
  await poll!();
  await settle();
  expect(materialReads).toBe(2); // Successful previews are not replaced on every poll.
});

test("status tabs show one queue at a time and clear selection when switching", async () => {
  const ui = await viewer();
  const tabs = ui.document.getElementById("queue-tabs")!;
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(3);
  expect(tabs.textContent).not.toContain('In progress');
  expect(tabs.textContent).toContain("Ready to apply (1)");
  const checkbox = ui.document.querySelector('input[type="checkbox"]')! as HTMLInputElement;
  checkbox.checked = true;
  checkbox.dispatchEvent(new ui.window.Event("change"));
  expect(ui.document.getElementById("apply-count")!.textContent).toContain("1 of 1");
  const choose = (label: string) => (Array.from(tabs.querySelectorAll("button")).find(button => button.textContent!.startsWith(label))! as unknown as HTMLButtonElement).click();
  choose("Applied");
  expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(0);
  expect(ui.document.getElementById("apply-bar")!.hasAttribute("hidden")).toBe(true);
  expect(tabs.querySelector('[aria-selected="true"]')!.textContent).toContain("Applied");
  choose("Ready to apply");
  expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
  expect(ui.document.getElementById("apply-count")!.textContent).toContain("0 of 1");
  expect(ui.writes).toEqual([]);
});

test("dashboard shows the blocker and requires acknowledgement and a reason before releasing", async () => {
  const { document, window } = parseHTML(DASHBOARD_PAGE);
  let blocks = [{ id: "uncertain-attempt", kind: "application", state: "outcome_unknown", createdAt: 1, updatedAt: 2, title: "Developer", employer: "Acme", jobKey: "waterlooworks:123", canRelease: false, releaseDisabledReason: "Wait two minutes." as string | null }];
  let poll: (() => Promise<void>) | undefined;
  const writes: Array<{ path: string; body: unknown }> = [];
  runInNewContext(DASHBOARD_SCRIPT, {
    document, URL, setTimeout: (callback: () => Promise<void>) => { poll = callback; return 1; }, clearTimeout: () => {},
    mintWriteApproval: async () => "minted-token",
    dashboardRequest: async (path: string, body?: unknown) => {
      if (path === "/api/state") return { jobs: [], submissionBlocks: blocks, health: { authenticated: true, bridgeConnected: true } };
      writes.push({ path, body });
      blocks = [];
      return { released: true };
    },
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await settle();
  const panel = document.getElementById("submission-blocks")!;
  expect(panel.textContent).toContain("An application needs your attention");
  expect(panel.textContent).toContain("Developer · Acme");
  (Array.from(panel.querySelectorAll("button")).find(button => button.textContent === "Unblock other jobs…")! as unknown as HTMLButtonElement).click();
  const overlay = document.querySelector("dialog")!;
  expect(overlay.textContent).toContain("does not submit anything");
  const form = overlay.querySelector("form")!;
  const release = form.querySelector("button")! as HTMLButtonElement;
  expect(release.disabled).toBe(true);
  form.dispatchEvent(new window.Event("submit"));
  await settle();
  expect(writes).toEqual([]);
  const reason = form.querySelector("textarea")! as HTMLTextAreaElement;
  reason.value = "I applied manually; continue with other jobs";
  const ack = form.querySelector("input")! as HTMLInputElement;
  ack.checked = true;
  form.dispatchEvent(new window.Event("input"));
  expect(release.disabled).toBe(true);
  blocks[0]!.canRelease = true;
  blocks[0]!.releaseDisabledReason = null;
  await poll!();
  await settle();
  expect(release.disabled).toBe(false);
  form.dispatchEvent(new window.Event("submit"));
  await settle();
  expect(writes).toEqual([{ path: "/api/submission-blocks/uncertain-attempt/release", body: { updatedAt: 2, acknowledged: true, reason: reason.value, approval: "minted-token" } }]);
  expect(panel.hidden).toBe(true);
  expect(document.getElementById("status")!.textContent).toContain("Nothing was submitted or retried");
});


test("fill-only selection requires a fresh confirmation and sends the chosen mode", async () => {
  const ui = await viewer();
  ui.document.getElementById("select-all")!.click();
  ui.document.getElementById("apply")!.click();
  await ui.settle();
  const mode = ui.document.getElementById("application-mode")!;
  for (const option of mode.querySelectorAll("option")) option.selected = option.value === "fill_only";
  mode.dispatchEvent(new ui.window.Event("change"));
  ui.document.getElementById("apply")!.click();
  await ui.settle();
  expect(ui.writes).toHaveLength(0);
  expect(ui.document.getElementById("apply")!.textContent).toContain("without submitting");
  ui.document.getElementById("apply")!.click();
  await ui.settle();
  expect(ui.bodies).toEqual([{ approvalHash: "test-hash", executionMode: "fill_only", approval: "minted-token" }]);
});


test("View in detail exposes the posting and requirements without a plan or writes", async () => {
  const ui = await viewer();
  const button = ui.button("View in detail");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  button.click();
  await ui.settle();
  const details = ui.document.querySelector(".details")!;
  expect(details.hasAttribute("hidden")).toBe(false);
  expect(details.textContent).toContain("Full responsibilities and qualifications.");
  expect(details.textContent).toContain("Resume (required)");
  expect(details.textContent).toContain("Portfolio (optional)");
  expect(details.textContent).toContain("Eligible? (required)");
  expect(details.textContent).toContain("Options: Yes · No");
  expect(details.textContent).toContain("No screening answers prepared.");
  expect(details.textContent).toContain("Email recruiter");
  expect(details.querySelector("script")).toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  button.click();
  expect(details.hasAttribute("hidden")).toBe(true);
  expect(ui.writes).toEqual([]);
});

test("details put documents first and formatted full posting last, previews open in an overlay", async () => {
  const ui = await viewer();
  ui.button("View in detail").click();
  await ui.settle();
  const details = ui.document.querySelector(".details")!;
  expect(details.firstElementChild!.textContent).toContain("View resume");
  expect(details.firstElementChild!.textContent).toContain("View cover letter");
  expect(details.lastElementChild!.className).toBe("posting-content");
  expect(details.querySelector(".description h4")!.textContent).toBe("Responsibilities");
  expect(details.querySelectorAll(".description li")).toHaveLength(2);
  expect(ui.document.querySelector(".job-title")!.textContent).toBe("Developer");
  ui.button("View resume (swe)").click();
  await ui.settle();
  const overlay = ui.document.querySelector("dialog")!;
  expect(overlay.getAttribute("open")).not.toBeNull();
  expect(overlay.querySelector("iframe")!.title).toBe("Resume · Developer");
  expect(details.querySelector("iframe")).toBeNull();
  ui.button("Close").click();
  expect(ui.document.querySelector("dialog")).toBeNull();
  expect(ui.document.body.classList.contains("overlay-open")).toBe(false);
});

test("filled forms count under Applied and obsolete actions and tabs are absent", async () => {
  const ui = await viewer("form_filled");
  const tabs = ui.document.getElementById("queue-tabs")!;
  expect(tabs.textContent).toContain("Applied (1)");
  expect(tabs.textContent).not.toContain("Form filled");
  expect(tabs.textContent).not.toContain("Skipped");
  Array.from(tabs.querySelectorAll("button")).find(button => button.textContent!.startsWith("Applied"))!.click();
  expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
  expect(ui.document.querySelector(".state")!.textContent).toContain("checking submission");
  const text = ui.document.getElementById("groups")!.textContent!;
  expect(text).not.toContain("I applied manually");
  expect(text).not.toContain("Skip");
});

test("legacy skipped jobs appear only in Removed jobs", async () => {
  const ui = await viewer("skipped");
  expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(0);
  await ui.view("removed");
  expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
  expect(ui.button("Restore to queue")).toBeDefined();
  expect(ui.document.querySelector(".state")!.textContent).toBe("Removed");
});

test("recovery gives an explicit acknowledged check and a path back to the ready job", async () => {
  const ui = await viewer("failed");
  const tabs = ui.document.getElementById("queue-tabs")!;
  Array.from(tabs.querySelectorAll("button")).find(button => button.textContent!.startsWith("Needs attention"))!.click();
  ui.button("Resolve application").click();
  const dialog = ui.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("This check never submits an application");
  const check = ui.button("Check status and prepare again") as HTMLButtonElement;
  expect(check.disabled).toBe(true);
  const ack = dialog.querySelector("input")! as HTMLInputElement;
  ack.checked = true;
  ack.dispatchEvent(new ui.window.Event("change"));
  check.click();
  await ui.settle();
  expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/recover"]);
  expect(dialog.textContent).toContain("back in Ready to apply");
  expect(check.disabled).toBe(true);
  ui.button("View in Ready to apply").click();
  await ui.settle();
  expect(ui.document.querySelector("dialog")).toBeNull();
  expect(ui.document.querySelector('#queue-tabs [aria-selected="true"]')!.textContent).toContain("Ready to apply");
  expect(ui.document.querySelectorAll("#groups .card")).toHaveLength(1);
});

test("recovery errors stay beside the check and never submit an application", async () => {
  const ui = await viewer("outcome_unknown");
  Array.from(ui.document.querySelectorAll<HTMLButtonElement>("#queue-tabs button")).find(button => button.textContent!.startsWith("Needs attention"))!.click();
  ui.button("Resolve application").click();
  const dialog = ui.document.querySelector("dialog")!;
  const ack = dialog.querySelector("input")! as HTMLInputElement;
  ack.checked = true;
  ack.dispatchEvent(new ui.window.Event("change"));
  ui.refuse();
  ui.button("Check status and prepare again").click();
  await ui.settle();
  expect(dialog.querySelector('[role="status"]')!.textContent).toBe("Already submitting");
  expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/recover"]);
});


test("submission health shows browser startup errors instead of asking an authenticated user to sign in",async()=>{
  const ui=await viewer("ready",undefined,{connected:true,authenticated:false,fillOnly:true,error:"Submission browser could not start. Check the server browser and display configuration."});
  expect(ui.document.querySelector("#health")!.textContent).toContain("Submission browser could not start");
  expect(ui.document.querySelector("#health")!.textContent).not.toContain("Sign in to sync your session");
});

for (const insider of [false, true]) {
  test(`All Applications displays and refreshes WaterlooWorks status for ${insider ? "Insider" : "Core"}`, async () => {
    const ui = await viewer("ready", undefined, undefined, {insider,email:"student@example.edu"});
    ui.applications.push(...["Submitted", "Selected for interview", "Not selected", "Cancelled", "", null].map((status, index) => ({
      applicationId:String(900+index),jobId:String(123+index),title:"Developer",employer:"Acme",location:"Toronto",term:"2027 - Winter",status,jobStatus:"Interview Selections Complete",submittedAt:"2026-11-01T12:00:00Z",
    })));
    ui.document.querySelector<HTMLButtonElement>('[data-tab="applications"]')!.click();
    await ui.settle();
    const statuses = () => Array.from(ui.document.querySelectorAll('#applications-panel .application-status')).map(node => node.textContent);
    expect(statuses()).toEqual(["Not selected (inferred)", "Selected for interview", "Not selected", "Cancelled", "Unavailable", "Unavailable"]);
    expect(ui.document.querySelector('#applications-panel .card .meta')!.textContent).toBe("Acme · Toronto · 2027 - Winter");
    ui.applications[0]!.status = "Interview scheduled";
    ui.button("Refresh applications").click();
    await ui.settle();
    expect(statuses()[0]).toBe("Interview scheduled");
    expect(ui.writes).toEqual([]);
    expect(ui.preparations).toEqual([]);
  });
}

test("All Applications infers not selected from a known job status and preserves source statuses", async () => {
  const ui = await viewer("ready", undefined, undefined, {insider:false});
  const jobs = ["Open for Applications", "Expired - Apps Available", "Expired - Apps Availible", "  OPEN FOR APPLICATIONS  ", "Interview Complete", "Emp Rankings Finalized", "Cancel", "Interview Selections Complete", "", undefined];
  ui.applications.push(...jobs.map((jobStatus,index)=>({applicationId:String(900+index),jobId:String(123+index),title:"Developer",employer:"Acme",location:"Toronto",term:"2027 - Winter",status:"Applied",...(jobStatus === undefined ? {} : {jobStatus}),submittedAt:"2026-11-01T12:00:00Z"})));
  ui.document.querySelector<HTMLButtonElement>('[data-tab="applications"]')!.click();
  await ui.settle();
  expect(Array.from(ui.document.querySelectorAll('#applications-panel .application-status')).map(node=>node.textContent)).toEqual(jobs.map((_,index)=>index>=4&&index<=7 ? "Not selected (inferred)" : "Applied"));
  expect(ui.document.querySelectorAll('#applications-panel .application-source-status')[4]!.textContent).toBe("Job status: Interview Complete · Application status: Applied");
  ui.applications[0]!.jobStatus = "Interview Selections Complete";
  ui.button("Refresh applications").click();
  await ui.settle();
  expect(ui.document.querySelector('#applications-panel .application-status')!.textContent).toBe("Not selected (inferred)");
  expect(ui.applications[0]!.status).toBe("Applied");
  expect(ui.writes).toEqual([]);
  expect(ui.preparations).toEqual([]);
});

test("manual application delay begins on each click, survives rerenders and opens only once", async () => {
  const ui = await viewer("ready", undefined, undefined, {insider:false});
  expect(ui.intervalCount).toBe(0);
  ui.tickDelay(20);
  expect(ui.writes).toEqual([]);
  ui.button("Apply manually in WaterlooWorks ↗").click();
  await ui.settle();
  expect(ui.intervalCount).toBe(1);
  expect(ui.writes).toEqual([]);
  ui.tickDelay(4);
  await ui.settle();
  expect(ui.writes).toEqual([]);
  expect(ui.button("Core plan · Apply manually in WaterlooWorks (opens in 1s)")).toBeDefined();
  ui.document.getElementById("job-search")!.dispatchEvent(new ui.window.Event("input"));
  const pending = ui.button("Core plan · Apply manually in WaterlooWorks (opens in 1s)") as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  pending.click();
  expect(ui.intervalCount).toBe(1);
  ui.tickDelay(1);
  await ui.settle();
  expect(ui.writes).toEqual(["/api/jobs/waterlooworks/123/open-application-form"]);
  expect(ui.intervalCount).toBe(0);
  ui.tickDelay(10);
  expect(ui.writes).toHaveLength(1);
  ui.button("Apply manually in WaterlooWorks ↗").click();
  await ui.settle();
  ui.tickDelay(4);
  expect(ui.writes).toHaveLength(1);
  ui.tickDelay(1);
  await ui.settle();
  expect(ui.writes).toHaveLength(2);
  expect(ui.preparations).toEqual([]);
});
