import { expect, test } from "bun:test";
import { applicationListRequest, parseApplications } from "../src/applications.js";

const row = (applicationId = "90001", jobId = "12345") => ({
  id: applicationId,
  data: [
    { key: "jobId", value: jobId },
    { key: "jobTitle", value: "Embedded Software Co-op" },
    { key: "organization", value: "Example Systems" },
    { key: "term", value: "2027 - Winter" },
    { key: "applicationStatus", value: "Submitted" },
    { key: "applicationSubmittedOn", value: "2026-10-30T14:15:00Z" },
    { key: "city", value: "Waterloo" },
  ],
});

test("parses sanitized application table rows with application ID distinct from posting ID", () => {
  expect(parseApplications({ totalResults: 1, data: [row()] })).toEqual({
    total: 1,
    applications: [{ applicationId: "90001", jobId: "12345", title: "Embedded Software Co-op", employer: "Example Systems",
      term: "2027 - Winter", status: "Submitted", submittedAt: "2026-10-30T14:15:00Z", location: "Waterloo" }],
  });
});

test("accepts an empty list and rejects invalid totals and duplicate fields", () => {
  expect(parseApplications({ totalResults: 0, data: [] })).toEqual({ total: 0, applications: [] });
  for (const totalResults of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", NaN]) {
    expect(() => parseApplications({ totalResults, data: [] })).toThrow();
  }
  const duplicate = row();
  duplicate.data.push({ key: "jobTitle", value: "conflicting title" });
  expect(() => parseApplications({ totalResults: 1, data: [duplicate] })).toThrow();
});

test("discovers a literal list request and rejects unexpected request keys", () => {
  const html = `<script>function cancel(){const request={action:'cancel'};}
    function load(){const request={action:'list', studentId:'11', postingModuleId:'22', selectedTerm:'2027W', numOfDays:0, status:'all'};}</script>`;
  expect(applicationListRequest(html)).toEqual({ action: "list", studentId: "11", postingModuleId: "22", selectedTerm: "2027W", numOfDays: "0", status: "all" });
  expect(() => applicationListRequest(`<script>const request={action:'list',studentId:'1',postingModuleId:'2',selectedTerm:'T',other:'unsafe'};</script>`)).toThrow();
  for (const declaration of ["const", "let", "var"]) {
    expect(applicationListRequest(`<script>${declaration} request={action:'list',studentId:'1',postingModuleId:'2',selectedTerm:'T'};</script>`))
      .toEqual({action:"list",studentId:"1",postingModuleId:"2",selectedTerm:"T"});
  }
  expect(() => applicationListRequest(`${html}${html}`)).toThrow("list candidates: 2");
  expect(applicationListRequest(`<script>const request={action: dynamicValue};</script>${html}`)).toMatchObject({action:"list"});
});

test("preserves the job status separately from application submission evidence", () => {
  for (const jobStatus of ["Open for Applications", "Expired - Apps Available", "Interview Complete", "Emp Rankings Finalized", "Cancel", "Interview Selections Complete"]) {
    const application = row();
    application.data.push({key:"jobStatus",value:jobStatus});
    expect(parseApplications({totalResults:1,data:[application]}).applications[0]).toMatchObject({status:"Submitted",jobStatus});
  }
  const application = row();
  application.data.push({key:"jobStatus",value:"   "});
  expect(parseApplications({totalResults:1,data:[application]}).applications[0]).not.toHaveProperty("jobStatus");
});
