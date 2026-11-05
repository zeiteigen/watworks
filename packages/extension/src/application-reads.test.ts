import { expect, test } from "bun:test";
import { WaterlooWorksApplicationGateway } from "../../waterlooworks-client/src/application-gateway.js";
import { BrowserApplicationReads } from "./application-reads.js";
import type { FetchLike } from "../../waterlooworks-client/src/session.js";
import { applicationOverview, applicationPdf, applicationSession, applicationWizard, documentsPage, inventoryPage, inventoryRow } from "../../waterlooworks-client/test/application-fixtures.js";

const jobsPage = await Bun.file(new URL("../../waterlooworks-client/test/fixtures/jobs-page.html", import.meta.url)).text()
  + `<script>function createApplication(){const request={action:'fake-create'};}</script>`;

function fixtureTransport(calls: Array<{ url: string; init: RequestInit | undefined }>): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body instanceof URLSearchParams ? init.body : url.searchParams;
    const action = String(body.get("action") ?? "GET");
    calls.push({ url: url.href, init });
    const html = (text: string) => new Response(text, { headers: { "content-type": "text/html; charset=UTF-8" } });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=UTF-8" } });
    if (action === "GET") return html(url.pathname.endsWith("documents.htm") ? documentsPage : jobsPage);
    if (action === "fake-docOwnerStats") return html(inventoryPage);
    if (action === "fake-grid") return html(inventoryRow);
    if (action === "fake-preview") return json({ doc: Buffer.from(applicationPdf).toString("base64") });
    if (action === "fake-data-action-for-tests") return json({
      postingId: "12345", position: "Sample Co-op", organization: "Example Employer", workTerm: "2027 - Winter",
      deadline: "2099-10-22T13:00:00Z", hasPreScreening: false,
      applicationData: { canApply: true, hasApplication: false },
    });
    if (action === "fake-overview-action-for-tests") return html(applicationOverview());
    if (action === "fake-create") return json({ canApply: true, hasApplication: false, expressedIntention: false, form: { action: "fake-open-wizard", postingId: "12345" } });
    if (action === "fake-open-wizard") return html(applicationWizard(false, false));
    throw new Error(`Unexpected fixture read: ${url.pathname} ${action}`);
  };
}

test("browser reads match the verified gateway form and keep private wizard data in the extension", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const transport = fixtureTransport(calls);
  const gateway = new WaterlooWorksApplicationGateway({ getSession: async () => applicationSession }, transport);
  const browser = new BrowserApplicationReads(transport);
  const expected = await gateway.getApplicationForm("12345");
  calls.length = 0;
  const actual = await browser.getApplicationForm("12345");
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).not.toContain("fake-wizard-state");
  expect(JSON.stringify(actual)).not.toContain("fake-open-wizard");
  expect(calls.every(({ init }) => {
    const headers = new Headers(init?.headers);
    return init?.credentials === "include" && !headers.has("cookie") && !headers.has("origin") && !headers.has("referer");
  })).toBe(true);
  expect(calls.some(({ init, url }) => {
    const action = init?.body instanceof URLSearchParams ? init.body.get("action") : new URL(url).searchParams.get("action");
    return ["fake-stage-attachment", "fake-save-attachment", "fake-commit"].includes(action ?? "");
  })).toBe(false);
  const snapshot = await browser.getDocumentSnapshot("100");
  expect(snapshot.document.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.bytes.length).toBe(applicationPdf.length);
  expect(await browser.getApplicationStatus("12345")).toEqual({ jobId: "12345", hasApplication: false });
});

test("expired postings use complete inventory only when the posting belongs to its selected term", async () => {
  let term = "2027 - Winter";
  const transport: FetchLike = async (_input, init) => {
    const action = init?.body instanceof URLSearchParams ? init.body.get("action") : undefined;
    if (!action) return new Response(jobsPage + `<data-filter filter-key="Term" label="Work Term" type="options" :options='[{value:"437",label:"2027 - Winter"}]'></data-filter>`);
    if (action === "fake-data-action-for-tests") return Response.json({ applicationData: { canApply: false }, workTerm: term });
    if (action === "fake-overview-action-for-tests") return new Response(applicationOverview());
    throw new Error("Unexpected read");
  };
  class ExpiredReads extends BrowserApplicationReads {
    override async listApplications() { return { accountKey: "a", checkedAt: new Date().toISOString(), termId: "437", applications: [] }; }
  }
  const reads = new ExpiredReads(transport);
  expect(await reads.getApplicationStatus("12345")).toEqual({ jobId: "12345", hasApplication: false });
  term = "2026 - Fall";
  await expect(reads.getApplicationStatus("12345")).rejects.toThrow("unavailable");
});

function applicationsTransport(options: { duplicate?: boolean; changedTotal?: boolean; switchAccount?: boolean } = {}) {
  const calls: Array<{ url: URL; params: URLSearchParams }> = [];
  let documentReads = 0;
  const transport: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const params = init?.body instanceof URLSearchParams ? init.body : url.searchParams;
    calls.push({ url, params: new URLSearchParams(params) });
    if (url.pathname.endsWith("documents.htm")) {
      documentReads++;
      const owner = options.switchAccount && documentReads > 1 ? "5678" : "1234";
      return new Response(documentsPage.replace("ownerId:'1234'", `ownerId:'${owner}'`), { headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (url.pathname.endsWith("applications.htm")) {
      if (!params.has("action")) return new Response(`<script>const request={action:'fake-list',studentId:'11',postingModuleId:'22',selectedTerm:'2027W'};</script>`, { headers: { "content-type": "text/html; charset=UTF-8" } });
      const page = Number(params.get("page"));
      const totalResults = options.changedTotal && page > 1 ? 47 : options.duplicate ? 46 : 46;
      const count = page === 1 ? 45 : 1;
      const data = Array.from({ length: count }, (_, index) => {
        const n = page === 1 ? index + 1 : 46;
        const id = options.duplicate && page === 2 ? "90001" : String(90000 + n);
        return { id, data: [
          { key: "jobId", value: String(12000 + n) }, { key: "jobTitle", value: `Role ${n}` },
          { key: "organization", value: "Example Employer" }, { key: "term", value: "2027 - Winter" },
          { key: "applicationStatus", value: "Submitted" }, { key: "applicationSubmittedOn", value: "2026-10-30T14:15:00Z" },
        ] };
      });
      return new Response(JSON.stringify({ totalResults, data }), { headers: { "content-type": "application/json; charset=UTF-8" } });
    }
    throw new Error(`Unexpected list fixture URL ${url}`);
  };
  return { calls, transport };
}

test("lists all application rows across pages when WaterlooWorks caps each response at 45", async () => {
  const { calls, transport } = applicationsTransport();
  const result = await new BrowserApplicationReads(transport).listApplications();
  expect(result.applications).toHaveLength(46);
  const pages = calls.filter(call => call.url.pathname.endsWith("applications.htm") && call.params.has("page"));
  expect(new Set(pages.map(call => call.params.get("page")))).toEqual(new Set(["1", "2"]));
  expect(pages.every(({ params }) => params.get("action") === "fake-list" && params.get("studentId") === "11" && params.get("postingModuleId") === "22" &&
    params.get("selectedTerm") === "2027W" && params.get("itemsPerPage") === "200" && params.get("isDataViewer") === "true")).toBe(true);
});

test("rejects duplicate rows, changing totals, and an account switch during listing", async () => {
  for (const options of [{ duplicate: true }, { changedTotal: true }, { switchAccount: true }]) {
    const { transport } = applicationsTransport(options);
    await expect(new BrowserApplicationReads(transport).listApplications()).rejects.toThrow();
  }
});

test("discovers applications through the site's literal My Applications navigation when the standalone page has no list",async()=>{
  const calls: string[]=[];
  const reads=new BrowserApplicationReads(async(input,init)=>{
    const url=new URL(String(input));
    const params=init?.body instanceof URLSearchParams ? init.body : url.searchParams;
    const action=params.get("action") ?? "GET";
    calls.push(`${url.pathname}:${action}`);
    if(url.pathname.endsWith("documents.htm")) return new Response(documentsPage);
    if(url.pathname.endsWith("applications.htm")) return new Response("<h1>WaterlooWorks</h1>");
    if(action==="GET") return new Response(`<a onclick="buildForm({action:'fake-open-applications'})">My Applications</a>`);
    if(action==="fake-open-applications") return new Response(`<script>const request={action:'fake-list',studentId:'11',postingModuleId:'22',selectedTerm:'437'};</script>`);
    if(action==="fake-list") return Response.json({totalResults:0,data:[]});
    throw new Error("Unexpected request");
  });
  const result=await reads.listApplications();
  expect(result.applications).toEqual([]);
  expect(calls.filter(call=>call.endsWith(":fake-list"))).toEqual(["/myAccount/co-op/full/jobs.htm:fake-list"]);
});

test("opens the Vue My Applications card at its source-declared applications path", async () => {
  const calls: Array<{path:string; action:string}> = [];
  const reads=new BrowserApplicationReads(async(input,init)=>{
    const path=new URL(String(input)).pathname;
    const params=init?.body instanceof URLSearchParams?init.body:new URLSearchParams();
    const action=params.get("action")??"GET";
    calls.push({path,action});
    if(path.endsWith("documents.htm"))return new Response(documentsPage);
    if(path.endsWith("jobs.htm"))return new Response(`<template><a @click="goToApplicationsGrid">My Applications</a></template><script>goToApplicationsGrid() { orbisApp.buildForm({action:'fake-applications-navigation',numOfDays:0,comingFromNp:true,refreshSearch:true}, '/myAccount/co-op/full/applications.htm').submit(); }</script>`);
    if(action==="GET")return new Response("<h1>Applications</h1>");
    if(action==="fake-applications-navigation")return new Response(`<script>const request={action:'fake-list',studentId:'11',postingModuleId:'22',selectedTerm:'437'};</script>`);
    if(action==="fake-list")return Response.json({totalResults:0,data:[]});
    throw new Error("Unexpected read");
  });
  expect((await reads.listApplications()).applications).toEqual([]);
  expect(calls.filter(c=>c.action!=="GET")).toEqual([
    {path:"/myAccount/co-op/full/applications.htm",action:"fake-applications-navigation"},
    {path:"/myAccount/co-op/full/applications.htm",action:"fake-list"},
  ]);
});
