import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { bundledTemplate, formatJobKey, WorkspacePaths, type JobKey } from "./paths.js";
import {
  ApplicationPlanSchema, CoverLetterSchema, JobDocumentSchema, JobStatusSchema, ProfileSchema, ResumeUploadsSchema, ResumeVariantSchema, SearchRecordSchema, StoredPostingSchema,
  type ApplicationPlan, type CoverLetter, type JobDocument, type JobState, type JobStatus, type Profile, type ResumeUploads, type ResumeVariant, type SearchRecord, type StoredPosting,
} from "./schemas.js";
import type { ApplicationForm } from "../../application-workflow/src/types.js";

/** Write via a sibling temp file so readers never observe partial JSON or PDFs. */
export async function writeAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, data, mode === undefined ? {} : { mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function readJson<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is invalid: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

const now = () => new Date().toISOString();

/** Agents may re-plan only these; pending confirmation can also be declined. */
const REPLANNABLE: readonly JobState[] = ["found", "planned", "ready", "skipped", "failed"];

export interface JobRecord {
  key: string;
  posting: StoredPosting;
  status: JobStatus;
  plan?: ApplicationPlan;
  documents: Array<{ id: string; kind: "cover_letter" | "document"; title: string }>;
}

export class Workspace {
  readonly paths: WorkspacePaths;

  constructor(root?: string) { this.paths = new WorkspacePaths(root); }

  /** Create the directory skeleton and seed editable templates without overwriting user edits. */
  async scaffold(): Promise<void> {
    for (const dir of [this.paths.profileDir, this.paths.templatesDir, this.paths.resumesDir, this.paths.jobsDir, this.paths.searchesDir]) await mkdir(dir, { recursive: true });
    if (!await exists(this.paths.resumeTemplate)) await copyFile(bundledTemplate("resume"), this.paths.resumeTemplate);
    if (!await exists(this.paths.coverLetterTemplate)) await copyFile(bundledTemplate("cover-letter"), this.paths.coverLetterTemplate);
    if (!await exists(this.paths.documentTemplate)) await copyFile(bundledTemplate("document"), this.paths.documentTemplate);
  }

  getProfile(): Promise<Profile | undefined> { return readJson(this.paths.profile, ProfileSchema); }
  async saveProfile(input: unknown): Promise<Profile> {
    const profile = ProfileSchema.parse(input);
    await writeJson(this.paths.profile, profile);
    return profile;
  }

  async getExperience(): Promise<string | undefined> {
    return readFile(this.paths.experience, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  }
  async saveExperience(markdown: string): Promise<void> {
    if (!markdown.trim()) throw new Error("Experience draft is empty");
    await writeAtomic(this.paths.experience, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }

  getResumeVariant(variant: string): Promise<ResumeVariant | undefined> { return readJson(this.paths.resume(variant).json, ResumeVariantSchema); }
  async saveResumeVariant(input: unknown): Promise<ResumeVariant> {
    const variant = ResumeVariantSchema.parse({ ...(input as object), updatedAt: now() });
    await writeJson(this.paths.resume(variant.variant).json, variant);
    return variant;
  }
  async listResumeVariants(): Promise<Array<{ variant: ResumeVariant; pdf?: string }>> {
    const names = await readdir(this.paths.resumesDir).catch(() => [] as string[]);
    const result: Array<{ variant: ResumeVariant; pdf?: string }> = [];
    for (const name of names.sort()) {
      const variant = await this.getResumeVariant(name).catch(() => undefined);
      if (!variant) continue;
      const pdf = this.paths.resume(name).pdf;
      result.push(await exists(pdf) ? { variant, pdf } : { variant });
    }
    return result;
  }

  async getResumeUploads(variant: string): Promise<ResumeUploads> { return await readJson(this.paths.resume(variant).uploads, ResumeUploadsSchema) ?? { uploads: [] }; }
  async recordResumeUpload(variant: string, upload: ResumeUploads["uploads"][number]): Promise<void> {
    const current = await this.getResumeUploads(variant);
    current.uploads = [...current.uploads.filter(item => !(item.source === upload.source && item.sha256 === upload.sha256)), upload];
    await writeJson(this.paths.resume(variant).uploads, current);
  }

  async saveJob(key: JobKey, posting: Omit<StoredPosting, "savedAt">, description: string, form?: ApplicationForm): Promise<JobStatus> {
    const paths = this.paths.job(key);
    await writeJson(paths.posting, StoredPostingSchema.parse({ ...posting, savedAt: now() }));
    await writeAtomic(paths.description, description);
    if (form) await writeJson(paths.form, form);
    const status = await this.getStatus(key);
    if (status) return status;
    return this.setStatus(key, { state: "found" });
  }

  getPosting(key: JobKey) { return readJson(this.paths.job(key).posting, StoredPostingSchema); }
  async getForm(key: JobKey): Promise<ApplicationForm | undefined> {
    const text = await readFile(this.paths.job(key).form, "utf8").catch(() => undefined);
    return text === undefined ? undefined : JSON.parse(text) as ApplicationForm;
  }
  async saveForm(key: JobKey, form: ApplicationForm): Promise<void> { await writeJson(this.paths.job(key).form, form); }
  getPlan(key: JobKey) { return readJson(this.paths.job(key).plan, ApplicationPlanSchema); }
  getCoverLetter(key: JobKey): Promise<CoverLetter | undefined> { return readJson(this.paths.job(key).coverLetterJson, CoverLetterSchema); }
  async saveCoverLetter(key: JobKey, input: unknown): Promise<CoverLetter> {
    await this.requireJob(key);
    const letter = CoverLetterSchema.parse(input);
    await writeJson(this.paths.job(key).coverLetterJson, letter);
    return letter;
  }

  async saveJobDocument(key: JobKey, document: string, input: unknown): Promise<JobDocument> {
    await this.requireJob(key);
    const value = JobDocumentSchema.parse(input);
    await writeJson(this.paths.jobDocument(key, document).json, value);
    return value;
  }

  /** Generated PDFs for a job: the cover letter and any other documents. */
  async listJobDocuments(key: JobKey): Promise<Array<{ id: string; kind: "cover_letter" | "document"; title: string; pdf: string }>> {
    const paths = this.paths.job(key);
    const result: Array<{ id: string; kind: "cover_letter" | "document"; title: string; pdf: string }> = [];
    if (await exists(paths.coverLetterPdf)) result.push({ id: "cover-letter", kind: "cover_letter", title: "Cover letter", pdf: paths.coverLetterPdf });
    for (const name of (await readdir(paths.documentsDir).catch(() => [] as string[])).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const files = this.paths.jobDocument(key, id);
      const document = await readJson(files.json, JobDocumentSchema).catch(() => undefined);
      if (document && await exists(files.pdf)) result.push({ id, kind: "document", title: document.title, pdf: files.pdf });
    }
    return result;
  }

  /** Persist a plan; the caller decides readiness after validating it against the form. */
  async savePlan(key: JobKey, input: unknown, blockers: string[]): Promise<{ plan: ApplicationPlan; status: JobStatus }> {
    const current = await this.requireJob(key);
    if (!REPLANNABLE.includes(current.state)) throw new Error(`Job is ${current.state}; it can no longer be re-planned`);
    const plan = ApplicationPlanSchema.parse(input);
    await writeJson(this.paths.job(key).plan, plan);
    const status = await this.setStatus(key, blockers.length ? { state: "planned", blockers } : { state: "ready" });
    return { plan, status };
  }

  async skipJob(key: JobKey, reason: string): Promise<JobStatus> {
    const current = await this.requireJob(key);
    // Awaiting confirmation has no running submission. Declining it removes
    // the card without approving, retrying, or changing the operation ledger.
    if (!REPLANNABLE.includes(current.state) && current.state !== "confirm_required") throw new Error(`Job is ${current.state}; it cannot be skipped`);
    return this.setStatus(key, { state: "skipped", reason, removedFromQueueAt: now() });
  }

  /** Queue removal retains the posting, materials, and application history. */
  async setQueueRemoved(key: JobKey, removed: boolean): Promise<JobStatus> {
    const current = await this.requireJob(key);
    if (removed && !REPLANNABLE.includes(current.state)) throw new Error(`Job is ${current.state}; it cannot be removed from the queue`);
    const { removedFromQueueAt: _, ...status } = current;
    const value = JobStatusSchema.parse({ ...status, updatedAt: now(), ...(removed ? { removedFromQueueAt: now() } : {}) });
    await writeJson(this.paths.job(key).status, value);
    return value;
  }

  getStatus(key: JobKey) { return readJson(this.paths.job(key).status, JobStatusSchema); }
  async setStatus(key: JobKey, status: Omit<JobStatus, "updatedAt" | "blockers" | "externalSteps"> & Partial<Pick<JobStatus, "blockers" | "externalSteps">>): Promise<JobStatus> {
    const current = await this.getStatus(key);
    const value = JobStatusSchema.parse({ ...(current?.removedFromQueueAt ? { removedFromQueueAt: current.removedFromQueueAt } : {}), ...status, updatedAt: now() });
    await writeJson(this.paths.job(key).status, value);
    return value;
  }

  async listJobs(filter?: { states?: readonly JobState[] }): Promise<JobRecord[]> {
    const records: JobRecord[] = [];
    for (const source of await readdir(this.paths.jobsDir).catch(() => [] as string[])) {
      for (const jobId of await readdir(join(this.paths.jobsDir, source)).catch(() => [] as string[])) {
        const key = { source, jobId };
        const [posting, status, plan] = await Promise.all([this.getPosting(key), this.getStatus(key), this.getPlan(key)]).catch(() => [undefined, undefined, undefined] as const);
        if (!posting || !status || (filter?.states && !filter.states.includes(status.state))) continue;
        const documents = (await this.listJobDocuments(key)).map(({ id, kind, title }) => ({ id, kind, title }));
        records.push({ key: formatJobKey(key), posting, status, ...(plan ? { plan } : {}), documents });
      }
    }
    return records.sort((a, b) => (a.plan?.rank ?? Infinity) - (b.plan?.rank ?? Infinity) || a.key.localeCompare(b.key));
  }

  async saveSearch(record: Omit<SearchRecord, "at">): Promise<string> {
    const at = now();
    const path = join(this.paths.searchesDir, `${at.replace(/[:.]/g, "-")}-${record.source}.json`);
    await writeJson(path, SearchRecordSchema.parse({ ...record, at }));
    return path;
  }

  private async requireJob(key: JobKey): Promise<JobStatus> {
    const status = await this.getStatus(key);
    if (!status) throw new Error(`Unknown job ${formatJobKey(key)}; save it with job_save first`);
    return status;
  }
}
