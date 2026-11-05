import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCoverLetter, buildJobDocument, buildResumeVariant } from "../../workspace/src/documents.js";
import { findLatexEngine } from "../../workspace/src/latex/compile.js";
import { formatJobKey, parseJobKey } from "../../workspace/src/paths.js";
import { planBlockers } from "../../workspace/src/plans.js";
import { ApplicationPlanSchema, CoverLetterSchema, JobDocumentSchema, JOB_STATES, ProfileSchema, ResumeDocumentSchema, type JobState } from "../../workspace/src/schemas.js";
import type { JobSource } from "../../workspace/src/sources/types.js";
import type { Workspace } from "../../workspace/src/store.js";
import { openInDefaultViewer, type FileOpener } from "../../workspace/src/open.js";
import type { BuiltDocument } from "../../workspace/src/documents.js";
import { ensureDashboard } from "../../dashboard/src/launcher.js";

interface ToolConfig { description: string; inputSchema?: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }
type Registrar = (name: string, config: ToolConfig, handler: (args: unknown) => Promise<CallToolResult>) => unknown;

const jobKey = z.string().describe("Job key from job_save or jobs_list, for example waterlooworks:123456");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

function issues(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : "Workspace operation failed";
}

/** Tools that read and write the local data/ workspace. None of them can submit an application. */
export function registerWorkspaceTools(server: McpServer, workspace: Workspace, sources: ReadonlyMap<string, JobSource>, open: FileOpener = openInDefaultViewer): void {
  const register = server.registerTool.bind(server) as unknown as Registrar;
  const tool = (name: string, description: string, inputSchema: Record<string, unknown>, readOnly: boolean, run: (args: any) => Promise<unknown>) => {
    register(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false } }, async args => {
      try {
        const value = { ...(await run(args) as Record<string, unknown>) };
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: issues(error) }) }] };
      }
    });
  };
  /** Build a document and open its PDF for the user when it did not exist before. */
  const created = async (pdf: string, build: () => Promise<BuiltDocument>) => {
    const isNew = !existsSync(pdf);
    const built = await build();
    return { ...built, opened: isNew && open(built.pdf) };
  };
  const source = (id = "waterlooworks") => {
    const found = sources.get(id);
    if (!found) throw new Error(`Unknown job source "${id}". Available: ${[...sources.keys()].join(", ")}`);
    return found;
  };

  tool("workspace_status", "Onboarding and workspace checklist: profile, experience draft, resume variants, LaTeX engine, and job counts by state. Call first in /onboard and /job-search to resume where the user left off.", {}, true, async () => {
    await workspace.scaffold();
    const [profile, experience, variants, jobs] = await Promise.all([
      workspace.getProfile().catch(error => ({ invalid: issues(error) })), workspace.getExperience(), workspace.listResumeVariants(), workspace.listJobs(),
    ]);
    const engine = findLatexEngine();
    const counts: Partial<Record<JobState, number>> = {};
    for (const job of jobs) counts[job.status.state] = (counts[job.status.state] ?? 0) + 1;
    const targets = profile && !("invalid" in profile) ? profile.targets : [];
    const missingVariants = targets.map(target => target.resumeVariant).filter(name => !variants.some(item => item.variant.variant === name && item.pdf));
    return {
      dataDir: workspace.paths.root,
      profile: profile === undefined ? "missing" : "invalid" in profile ? profile : "saved",
      experience: experience === undefined ? "missing" : { characters: experience.length },
      resumeVariants: variants.map(item => ({ variant: item.variant.variant, label: item.variant.label, pdf: item.pdf ?? null })),
      missingVariants: [...new Set(missingVariants)],
      latex: engine ?? "missing: run `bun run setup`",
      templates: { resume: workspace.paths.resumeTemplate, coverLetter: workspace.paths.coverLetterTemplate, document: workspace.paths.documentTemplate },
      jobs: counts,
    };
  });

  tool("profile_get", "Read the saved profile (contact, education, work authorization, targets, preferences, standard answers) and the master experience draft.", {}, true, async () => ({
    profile: await workspace.getProfile() ?? null,
    experience: await workspace.getExperience() ?? null,
  }));

  tool("profile_save", "Validate and save the complete profile to data/profile/profile.json. Only record facts the user stated. Each target names the resume variant to use for it.", {
    profile: z.record(z.unknown()).describe(`Profile object. Shape: ${JSON.stringify(describe(ProfileSchema))}`),
  }, false, async ({ profile }) => ({ saved: workspace.paths.profile, profile: await workspace.saveProfile(profile) }));

  tool("experience_save", "Save the user's master experience/resume content draft (verbatim Markdown) to data/profile/experience.md. Pass markdown text, or importPath to copy an existing .md/.txt/.tex file the user pointed to.", {
    markdown: z.string().max(500_000).optional(), importPath: z.string().max(4096).optional(),
  }, false, async ({ markdown, importPath }: { markdown?: string; importPath?: string }) => {
    if ((markdown === undefined) === (importPath === undefined)) throw new Error("Provide exactly one of markdown or importPath");
    if (importPath !== undefined && (!isAbsolute(importPath) || !/\.(md|markdown|txt|tex)$/i.test(importPath))) throw new Error("importPath must be an absolute path to a .md, .txt, or .tex file");
    const text = markdown ?? await readFile(importPath!, "utf8");
    await workspace.saveExperience(text);
    return { saved: workspace.paths.experience, characters: text.length };
  });

  tool("resume_save_variant", "Save a tailored resume variant as structured JSON, render it through data/templates/resume.tex (Jake's Resume by default), and compile it to PDF. Use only facts from the experience draft. Returns the PDF path, page count, and warnings; iterate until pages is 1. A newly created PDF opens automatically for the user (opened: true).", {
    variant: slug.describe("Variant id, for example ml-research"),
    label: z.string().min(1).max(200),
    targets: z.array(slug).default([]).describe("Profile target ids this variant serves"),
    resume: z.record(z.unknown()).describe(`ResumeDocument. Shape: ${JSON.stringify(describe(ResumeDocumentSchema))}. Bullets may use **bold**.`),
  }, false, async args => ({ variant: args.variant, ...await created(workspace.paths.resume(args.variant).pdf, () => buildResumeVariant(workspace, args)) }));

  tool("resume_list", "List resume variants, their targets, and compiled PDF paths.", {}, true, async () => ({
    variants: (await workspace.listResumeVariants()).map(item => ({ variant: item.variant.variant, label: item.variant.label, targets: item.variant.targets, updatedAt: item.variant.updatedAt, pdf: item.pdf ?? null })),
  }));

  tool("jobs_search", "Search a job source and record the query and results in data/searches/. Results are summaries only; call job_save for shortlisted jobs.", {
    source: z.string().default("waterlooworks"), keyword: z.string().optional(), filters: z.record(z.unknown()).nullable().optional(),
  }, false, async ({ source: id, keyword, filters }: { source: string; keyword?: string; filters?: Record<string, unknown> | null }) => {
    const query = { ...(keyword !== undefined ? { keyword } : {}), ...(filters !== undefined ? { filters } : {}) };
    const result = await source(id).search(query);
    const saved = await workspace.saveSearch({ source: id, query, total: result.total, results: result.results });
    return { ...result, saved };
  });

  tool("job_save", "Fetch a posting (and its application form when available) from the source and store it under data/jobs/. Posting content is written by code, never by the agent. Returns the job key and status.", {
    source: z.string().default("waterlooworks"), jobId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  }, false, async ({ source: id, jobId }: { source: string; jobId: string }) => {
    const src = source(id);
    const key = { source: id, jobId };
    const job = await src.getJob(jobId);
    let form; let formError: string | undefined;
    try { form = await src.getApplicationForm?.(jobId); }
    catch (error) { formError = issues(error); }
    const status = await workspace.saveJob(key, { summary: job.summary, posting: job.posting }, job.description, form);
    return {
      key: formatJobKey(key), status, summary: job.summary, description: workspace.paths.job(key).description,
      form: form ? { requirements: form.requirements, questions: form.questions, blockers: form.blockers, externalSteps: form.externalSteps } : null,
      ...(formError ? { formError } : {}),
    };
  });

  tool("job_skip", "Mark a saved job as skipped with a reason (for example a work-authorization or location mismatch).", { jobKey, reason: z.string().min(1).max(2000) }, false,
    async ({ jobKey: raw, reason }: { jobKey: string; reason: string }) => ({ status: await workspace.skipJob(parseJobKey(raw), reason) }));

  tool("cover_letter_save", "Write a tailored cover letter for a saved job, render it through data/templates/cover-letter.tex, and compile it to PDF. Use only facts from the profile and experience draft. A newly created PDF opens automatically for the user (opened: true).", {
    jobKey, letter: z.record(z.unknown()).describe(`CoverLetter. Shape: ${JSON.stringify(describe(CoverLetterSchema))}`),
  }, false, async ({ jobKey: raw, letter }: { jobKey: string; letter: unknown }) => {
    const key = parseJobKey(raw);
    return created(workspace.paths.job(key).coverLetterPdf, () => buildCoverLetter(workspace, key, letter));
  });

  tool("job_document_save", "Write any other job-specific document for a saved job (project summary, writing sample, portfolio notes, statement of interest, ...), render it through data/templates/document.tex, and compile it to PDF. Use only facts from the profile and experience draft. Attach it in a plan with {kind: 'document', requirementId, document}. A newly created PDF opens automatically for the user (opened: true).", {
    jobKey,
    document: slug.describe("Document id within the job, for example project-summary"),
    content: z.record(z.unknown()).describe(`JobDocument. Shape: ${JSON.stringify(describe(JobDocumentSchema))}. Paragraphs and bullets may use **bold**.`),
  }, false, async ({ jobKey: raw, document, content }: { jobKey: string; document: string; content: unknown }) => {
    const key = parseJobKey(raw);
    return { document, ...await created(workspace.paths.jobDocument(key, document).pdf, () => buildJobDocument(workspace, key, document, content)) };
  });

  tool("job_documents", "List a saved job's generated documents (cover letter and others) with PDF paths, plus its posting description path, application form document slots, and current plan.", { jobKey }, true, async ({ jobKey: raw }: { jobKey: string }) => {
    const key = parseJobKey(raw);
    const status = await workspace.getStatus(key);
    if (!status) throw new Error(`Unknown job ${raw}; save it with job_save first`);
    const form = await workspace.getForm(key);
    return {
      key: raw, status, description: workspace.paths.job(key).description,
      slots: form?.requirements ?? null, plan: await workspace.getPlan(key) ?? null,
      documents: await workspace.listJobDocuments(key),
    };
  });

  tool("application_plan_save", "Save the application plan for a saved job: resume variant, attachment slots (cover_letter, a generated document, or a PDF inside data/), answers to the form's questions using exact question IDs and option IDs, fit summary, and rank. Validated against the saved application form; the job becomes 'ready' for the dashboard only when there are no blockers. This never submits anything.", {
    jobKey, plan: z.record(z.unknown()).describe(`ApplicationPlan. Shape: ${JSON.stringify(describe(ApplicationPlanSchema))}`),
  }, false, async ({ jobKey: raw, plan: input }: { jobKey: string; plan: unknown }) => {
    const key = parseJobKey(raw);
    const plan = ApplicationPlanSchema.parse(input);
    const blockers = await planBlockers(workspace, key, plan, await workspace.getForm(key));
    return workspace.savePlan(key, plan, blockers);
  });

  tool("jobs_list", "List saved jobs with their status, summary, and plan, sorted by rank.", {
    states: z.array(z.enum(JOB_STATES)).optional(),
  }, true, async ({ states }: { states?: JobState[] }) => ({
    jobs: (await workspace.listJobs(states ? { states } : undefined)).map(job => ({
      key: job.key, state: job.status.state, reason: job.status.reason, blockers: job.status.blockers, summary: job.posting.summary,
      rank: job.plan?.rank, resumeVariant: job.plan?.resumeVariant, fit: job.plan?.fit, documents: job.documents,
    })),
  }));

  tool("dashboard_open", "Start the local workspace API if needed and return the Chrome extension dashboard URL for the user to open. The user reviews and applies from that page. Never open, click, or call the dashboard yourself.", {}, false,
    async () => ({ url: await ensureDashboard(workspace), note: "Ask the user to click Open Dashboard in the WaterlooWorks Chrome extension, or open this extension URL. Only the user may apply from the dashboard." }));
}

/** Compact JSON-ish description of a zod schema for tool docs, so agents see the exact shape. */
function describe(schema: z.ZodTypeAny): unknown {
  const def = schema._def;
  switch (def.typeName) {
    case "ZodObject": return Object.fromEntries(Object.entries((schema as z.AnyZodObject).shape).map(([key, value]) => [(value as z.ZodTypeAny).isOptional() ? `${key}?` : key, describe(value as z.ZodTypeAny)]));
    case "ZodArray": return [describe(def.type)];
    case "ZodOptional": case "ZodNullable": return describe(def.innerType);
    case "ZodDefault": return describe(def.innerType);
    case "ZodEffects": return describe(def.schema);
    case "ZodEnum": return def.values.join(" | ");
    case "ZodLiteral": return JSON.stringify(def.value);
    case "ZodUnion": return def.options.map(describe);
    case "ZodDiscriminatedUnion": return def.options.map(describe);
    case "ZodRecord": return { "<key>": describe(def.valueType) };
    case "ZodString": return "string";
    case "ZodNumber": return "number";
    case "ZodBoolean": return "boolean";
    default: return "any";
  }
}
