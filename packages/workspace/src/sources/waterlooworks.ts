import type { ApplicationWorkflow } from "../../../application-workflow/src/workflow.js";
import type { JobPosting, JobSearchItem, WaterlooWorksClient } from "../../../waterlooworks-client/src/index.js";
import type { JobSummary } from "../schemas.js";
import type { JobSource } from "./types.js";

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

function summaryFromItem(item: JobSearchItem): JobSummary {
  return defined({
    source: "waterlooworks", jobId: item.id, title: item.title ?? "Untitled posting", employer: item.organization ?? item.division ?? "Unknown employer",
    location: item.city, deadline: item.deadline ?? item.deadlineDisplay, requiredDocuments: [],
    hasApplication: item.hasApplication ?? item.titleFlags?.applied,
  }) as JobSummary;
}

function locationText(posting: JobPosting): string | undefined {
  const location = posting.location;
  if (!location) return undefined;
  return location.fullAddress ?? [location.city, location.region, location.country].filter(Boolean).join(", ");
}

function summaryFromPosting(posting: JobPosting): JobSummary {
  return defined({
    source: "waterlooworks", jobId: posting.id, title: posting.title ?? "Untitled posting", employer: posting.organization ?? posting.division ?? "Unknown employer",
    location: locationText(posting), deadline: posting.deadline ?? posting.deadlineDisplay ?? posting.application?.deadline,
    term: posting.workTerm, arrangement: posting.workArrangement, compensation: posting.compensation,
    requiredDocuments: posting.application?.requiredDocuments ?? [],
  }) as JobSummary;
}

/** Plain-text posting rendered as Markdown for agents and the dashboard. */
export function postingMarkdown(posting: JobPosting): string {
  const summary = summaryFromPosting(posting);
  const facts: Array<[string, string | undefined]> = [
    ["Employer", summary.employer], ["Location", summary.location], ["Arrangement", posting.workArrangement], ["Term", posting.workTerm],
    ["Duration", posting.workTermDuration], ["Compensation", posting.compensation], ["Deadline", summary.deadline],
    ["Required documents", summary.requiredDocuments.join(", ") || undefined], ["Application method", posting.application?.method],
  ];
  const sections: Array<[string, string | undefined]> = [
    ["Summary", posting.summary], ["Description", posting.description], ["Responsibilities", posting.responsibilities],
    ["Qualifications", posting.qualifications], ["Required skills", posting.requiredSkills ?? posting.skills?.join(", ")],
    ["Special requirements", posting.specialRequirements], ["Targeted degrees and disciplines", posting.targetedDegreesAndDisciplines],
    ["Application instructions", posting.applicationInstructions ?? posting.application?.additionalInformation],
  ];
  const questions = posting.preScreening?.questions.map(question => `- ${question.question}${question.options?.length ? ` (options: ${question.options.join(" / ")})` : ""}`).join("\n");
  return [
    `# ${summary.title} (${posting.id})`, "",
    ...facts.filter(([, value]) => value).map(([label, value]) => `- **${label}:** ${value}`), "",
    ...sections.filter(([, value]) => value?.trim()).flatMap(([label, value]) => [`## ${label}`, "", value!.trim(), ""]),
    ...(questions ? ["## Pre-screening questions", "", questions, ""] : []),
  ].join("\n");
}

export class WaterlooWorksSource implements JobSource {
  readonly id = "waterlooworks";

  constructor(private readonly client: Pick<WaterlooWorksClient, "searchJobs" | "getJob">, private readonly applications: ApplicationWorkflow) {}

  async search(query: { keyword?: string; filters?: Record<string, unknown> | null }) {
    const result = await this.client.searchJobs(query);
    return { total: result.total, results: result.items.map(summaryFromItem) };
  }

  async getJob(jobId: string) {
    const { raw: _raw, ...posting } = await this.client.getJob(jobId, { includePreScreening: true });
    return { summary: summaryFromPosting(posting), posting: posting as Record<string, unknown>, description: postingMarkdown(posting) };
  }

  getApplicationForm(jobId: string) { return this.applications.getApplicationForm(jobId); }
}
