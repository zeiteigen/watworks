import type { ApplicationForm } from "../../../application-workflow/src/types.js";
import type { JobSummary } from "../schemas.js";

/** A job board. WaterlooWorks is the only implementation today; others plug in here. */
export interface JobSource {
  readonly id: string;
  search(query: { keyword?: string; filters?: Record<string, unknown> | null }): Promise<{ total: number; results: JobSummary[] }>;
  /** Full posting facts, fetched by code so stored postings are never agent-authored. */
  getJob(jobId: string): Promise<{ summary: JobSummary; posting: Record<string, unknown>; description: string }>;
  /** The structured application form, when the source supports in-platform applications. */
  getApplicationForm?(jobId: string): Promise<ApplicationForm>;
}
