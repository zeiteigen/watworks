import { dirname, isAbsolute, join, resolve } from "node:path";

/** Repository root for source checkouts; the executable's folder for standalone releases. */
export function installRoot(): string {
  return Bun.isStandaloneExecutable ? dirname(process.execPath) : resolve(import.meta.dir, "../../..");
}

export function dataRoot(): string {
  const configured = process.env.WAT_DATA_DIR;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("WAT_DATA_DIR must be an absolute directory path");
    return configured;
  }
  return join(installRoot(), "data");
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSlug(value: string, label = "identifier"): string {
  if (!SLUG.test(value)) throw new Error(`Invalid ${label}: use lowercase letters, digits, and hyphens`);
  return value;
}

export interface JobKey { source: string; jobId: string }

export function parseJobKey(key: string): JobKey {
  const [source, jobId, ...rest] = key.split(":");
  if (!source || !jobId || rest.length || !SLUG.test(source) || !JOB_ID.test(jobId)) throw new Error("Job keys look like waterlooworks:123456");
  return { source, jobId };
}

export function formatJobKey(key: JobKey): string { return `${key.source}:${key.jobId}`; }

/** The only place that knows the on-disk layout of data/. */
export class WorkspacePaths {
  constructor(readonly root: string = dataRoot()) {}

  get profileDir() { return join(this.root, "profile"); }
  get profile() { return join(this.profileDir, "profile.json"); }
  get experience() { return join(this.profileDir, "experience.md"); }
  get templatesDir() { return join(this.root, "templates"); }
  get resumeTemplate() { return join(this.templatesDir, "resume.tex"); }
  get coverLetterTemplate() { return join(this.templatesDir, "cover-letter.tex"); }
  get documentTemplate() { return join(this.templatesDir, "document.tex"); }
  get resumesDir() { return join(this.root, "resumes"); }
  get jobsDir() { return join(this.root, "jobs"); }
  get searchesDir() { return join(this.root, "searches"); }

  approvalSnapshot(id: string, filenames: string[]) {
    const dir=join(this.root,"approved-snapshots",assertSlug(id,"snapshot identifier"));
    if(filenames.some(name=>!name||name==="."||name===".."||/[\\/]/.test(name)))throw new Error("Invalid snapshot filename");
    return {dir,resume:join(dir,"resume.pdf"),attachments:filenames.map((name,i)=>join(dir,String(i),name))};
  }

  resume(variant: string) {
    const dir = join(this.resumesDir, assertSlug(variant, "resume variant"));
    return { dir, json: join(dir, "resume.json"), tex: join(dir, "resume.tex"), pdf: join(dir, "resume.pdf"), uploads: join(dir, "upload.json") };
  }

  job(key: JobKey) {
    const dir = join(this.jobsDir, assertSlug(key.source, "job source"), parseJobKey(formatJobKey(key)).jobId);
    return {
      dir,
      posting: join(dir, "posting.json"),
      description: join(dir, "description.md"),
      form: join(dir, "form.json"),
      plan: join(dir, "plan.json"),
      status: join(dir, "status.json"),
      coverLetterJson: join(dir, "cover-letter.json"),
      coverLetterTex: join(dir, "cover-letter.tex"),
      coverLetterPdf: join(dir, "cover-letter.pdf"),
      documentsDir: join(dir, "documents"),
    };
  }

  /** Other job-specific documents, such as a project summary or writing sample. */
  jobDocument(key: JobKey, document: string) {
    const dir = this.job(key).documentsDir;
    const name = assertSlug(document, "document id");
    return { json: join(dir, `${name}.json`), tex: join(dir, `${name}.tex`), pdf: join(dir, `${name}.pdf`) };
  }
}

export type TemplateKind = "resume" | "cover-letter" | "document";

const BUNDLED: Record<TemplateKind, string> = { resume: "resume/jake.tex", "cover-letter": "cover-letter/default.tex", document: "document/default.tex" };

/** Bundled defaults, copied into data/templates/ so users can edit their own copies. */
export function bundledTemplate(kind: TemplateKind): string {
  return join(installRoot(), "templates", BUNDLED[kind]);
}
