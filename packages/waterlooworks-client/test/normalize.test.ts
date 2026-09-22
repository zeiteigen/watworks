import { describe, expect, test } from "bun:test";
import {
  normalizeDocumentMetadata,
  normalizeEmployerReport,
  normalizeJobPosting,
  normalizeJobSearchItem,
} from "../src/normalize.js";

describe("WaterlooWorks normalization", () => {
  test("retains search flags and all safe row attributes", () => {
    const item = normalizeJobSearchItem({
      id: "12345",
      data: [
        { key: "postingId", value: "12345" },
        { key: "JobTitle", value: { postingTitle: "Example Co-op", new: true, featured: false, applied: false, viewed: true } },
        { key: "Organization", value: "Example Co" },
        { key: "Deadline", value: "Sep 22, 2026 9:00 AM" },
        { key: "deadline", value: "2026-09-22T09:00:00-0400" },
        { key: "online", value: true },
        { key: "apply", value: true },
        { key: "customField", value: "preserved" },
      ],
    });

    expect(item).toMatchObject({
      id: "12345",
      title: "Example Co-op",
      titleFlags: { isNew: true, featured: false, applied: false, viewed: true },
      deadline: "2026-09-22T09:00:00-0400",
      deadlineDisplay: "Sep 22, 2026 9:00 AM",
      online: true,
      apply: true,
      attributes: { customField: "preserved" },
    });
  });

  test("normalizes rich posting detail, application requirements, and pre-screening", () => {
    const overview = `
      <div><span class="label">Work Term:</span><p>2027 - Winter</p></div>
      <div><span class="label">Job Type:</span><p>Co-op Main</p></div>
      <div><span class="label">Job Summary:</span><p>Build useful systems.</p></div>
      <div><span class="label">Job Responsibilities:</span><p>Ship and test features.</p></div>
      <div><span class="label">Required Skills:</span><p>TypeScript and testing.</p></div>
      <div><span class="label">Compensation and Benefits:</span><p>$30 per hour.</p></div>
      <div><span class="label">Application Documents Required:</span><p>Résumé, Grade Report</p></div>
      <div><span class="label">Additional Application Information:</span><p>Apply at https://example.test/jobs/12345</p></div>
      <div><span class="label">Application Method:</span><p>WaterlooWorks</p></div>
      <div><span class="label">Application Deadline</span><p>Sep 22, 2026 9:00 AM</p></div>
      <div><strong>SERVICE TEAM</strong><table><tr><td>EEM</td><td>Example Contact (555-0100)</td></tr></table></div>
    `;
    const preScreening = `
      <div class="js--question--container">
        <span class="label">Can you work the full term?</span>
        <ul><li>Yes</li><li>No</li></ul>
      </div>`;

    const posting = normalizeJobPosting(
      "12345",
      {
        postingId: "12345",
        position: "Systems Co-op",
        org: "Example Co",
        div: "Engineering",
        divId: 99,
        status: "Approved",
        internalStatus: "Open for Applications",
        tags: ["NEW"],
        hasPreScreening: true,
        defaultLocations: [{ name: "Main campus", fullAddress: "1 Example Street" }],
        geoData: {
          city: "Waterloo",
          province: "Ontario",
          country: "Canada",
          address: ["1 Example Street", "Suite 2"],
          postalCode: "N2L 1A1",
          latitude: 43.47,
          longitude: -80.54,
        },
        applicationData: { canApply: true, hasApplication: false, buttonLabel: "Apply" },
      },
      overview,
      preScreening,
    );

    expect(posting).toMatchObject({
      id: "12345",
      divisionId: "99",
      status: "Approved",
      internalStatus: "Open for Applications",
      tags: ["NEW"],
      location: { city: "Waterloo", addressLineOne: "1 Example Street", latitude: 43.47 },
      locations: [{ name: "Main campus", fullAddress: "1 Example Street" }],
      workTerm: "2027 - Winter",
      jobType: "Co-op Main",
      summary: "Build useful systems.",
      responsibilities: "Ship and test features.",
      requiredSkills: "TypeScript and testing.",
      compensation: "$30 per hour.",
      deadline: "Sep 22, 2026 9:00 AM",
      application: {
        canApply: true,
        buttonLabel: "Apply",
        method: "WaterlooWorks",
        website: "https://example.test/jobs/12345",
        requiredDocuments: ["Résumé", "Grade Report"],
      },
      serviceTeam: [{ role: "EEM", name: "Example Contact", contact: "555-0100" }],
      preScreening: {
        text: "Can you work the full term?\nYes\nNo",
        questions: [{ question: "Can you work the full term?", options: ["Yes", "No"] }],
      },
    });
    expect(posting.preScreening).not.toEqual(expect.objectContaining({ text: expect.stringContaining("<") }));
    expect("preScreeningQuestions" in posting).toBe(false);
  });

  test("normalizes document metadata and employer report sections", () => {
    const documents = normalizeDocumentMetadata({
      docTypes: { "67": { id: 67, name: "Résumé", maxDefault: 3 } },
      defaultDocMap: { "67": [] },
      defaultPackageEnabled: true,
      specialDocs: { gradeReport: { id: 42, name: "Grade Report" } },
      docModuleSe: "/myAccount/co-op/full/documents.htm",
    });
    const report = normalizeEmployerReport({
      page: "<div>Hiring History</div>",
      sections: [
        { type: "text", value: "<strong>Organization:</strong> Example Co" },
        {
          type: "table",
          title: "<b>Hiring History</b>",
          description: "<div>Past nine terms</div>",
          columns: ["", "Students Hired", "2025 - Fall", "2026 - Winter"],
          rows: [["Employer Organization", "Example Co", "4", "3"]],
        },
        { type: "pieChart", title: "Hires by Faculty<br>Example Co", data: [{ name: "Engineering", y: "100" }] },
        {
          type: "pieChart",
          title: "Hires by Student Work Term Number<br>Example Co",
          data: [{ name: "Third", y: "50" }],
          valueSuffix: "%",
        },
        {
          type: "barChart",
          title: "Most Frequently Hired Programs - Example Co",
          categories: ["Computer Science/BCS"],
          series: [{ name: "Hires", data: [4] }],
        },
        {
          type: "table",
          title: "<b>Work Term Ratings Summary</b>",
          columns: ["", "Average Work Term Satisfaction Rating", "Number Of Ratings"],
          rows: [["Employer Organization", "Example Co", "8.9", "50"]],
        },
        {
          type: "columnChart",
          title: "Overall Work Term Satisfaction - Distribution of Student Ratings (1-10 scale)",
          categories: ["1", "10"],
          series: [{ name: "Example Co", data: [0, 100] }],
          valueSuffix: "%",
        },
        {
          type: "mixedChart",
          title: "Average Rating by Question (1-5 scale)",
          categories: ["Q1. Support", "Q2. Learning"],
          series: [{ name: "Example Co", type: "column", data: [4.7, 4.4] }],
        },
      ],
    });

    expect(documents).toMatchObject({
      docTypes: { "67": { id: "67", name: "Résumé", maxDefault: 3 } },
      defaultPackageEnabled: true,
      documentModuleUrl: "/myAccount/co-op/full/documents.htm",
    });
    expect(report.sections.slice(0, 2)).toEqual([
      { type: "text", value: "Organization: Example Co" },
      { type: "table", title: "Hiring History", description: "Past nine terms", columns: ["", "Students Hired", "2025 - Fall", "2026 - Winter"], rows: [["Employer Organization", "Example Co", "4", "3"]] },
    ]);
    expect(report).toMatchObject({
      title: "Hiring History",
      organization: "Example Co",
      reportAvailable: true,
      analytics: {
        hiringHistory: {
          title: "Hiring History",
          description: "Past nine terms",
          columns: ["", "Students Hired", "2025 - Fall", "2026 - Winter"],
          rows: [["Employer Organization", "Example Co", 4, 3]],
        },
        hiresByFaculty: { data: [{ name: "Engineering", y: 100 }] },
        hiresByStudentWorkTermNumber: { data: [{ name: "Third", y: 50 }], valueSuffix: "%" },
        mostFrequentlyHiredPrograms: {
          categories: ["Computer Science/BCS"],
          series: [{ name: "Hires", data: [4] }],
        },
        workTermRatingsSummary: {
          title: "Work Term Ratings Summary",
          rows: [["Employer Organization", "Example Co", 8.9, 50]],
        },
        overallWorkTermSatisfaction: {
          type: "columnChart",
          series: [{ name: "Example Co", data: [0, 100] }],
        },
        averageRatingByQuestion: {
          type: "mixedChart",
          series: [{ name: "Example Co", type: "column", data: [4.7, 4.4] }],
        },
        charts: [
          { type: "pieChart" },
          { type: "pieChart" },
          { type: "barChart" },
          { type: "columnChart" },
          { type: "mixedChart" },
        ],
      },
    });
  });

  test("normalizes employers without a hiring-history report as a no-data result", () => {
    expect(normalizeEmployerReport({ missingReportStructure: true })).toEqual({
      sections: [],
      reportAvailable: false,
    });
  });
});
