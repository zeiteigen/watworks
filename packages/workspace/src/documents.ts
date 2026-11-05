import { readFile } from "node:fs/promises";
import { bundledTemplate, type JobKey, type TemplateKind } from "./paths.js";
import { compileLatex } from "./latex/compile.js";
import { renderCoverLetter, renderJobDocument, renderResume } from "./latex/render.js";
import { writeAtomic, type Workspace } from "./store.js";

export interface BuiltDocument { pdf: string; tex: string; pages: number; warnings: string[] }

async function template(userPath: string, kind: TemplateKind): Promise<string> {
  return readFile(userPath, "utf8").catch(() => readFile(bundledTemplate(kind), "utf8"));
}

/** Validate, render through the user's template, compile, and store a resume variant. */
export async function buildResumeVariant(workspace: Workspace, input: unknown): Promise<BuiltDocument> {
  const variant = await workspace.saveResumeVariant(input);
  const paths = workspace.paths.resume(variant.variant);
  const tex = renderResume(await template(workspace.paths.resumeTemplate, "resume"), variant.resume);
  await writeAtomic(paths.tex, tex);
  const compiled = await compileLatex(tex);
  await writeAtomic(paths.pdf, compiled.bytes);
  const warnings = compiled.pages > 1 ? [`Resume is ${compiled.pages} pages; trim bullets or sections until it fits on one page.`] : [];
  return { pdf: paths.pdf, tex: paths.tex, pages: compiled.pages, warnings };
}

export async function buildCoverLetter(workspace: Workspace, key: JobKey, input: unknown): Promise<BuiltDocument> {
  const profile = await workspace.getProfile();
  if (!profile) throw new Error("Save a profile before writing cover letters");
  const letter = await workspace.saveCoverLetter(key, input);
  const paths = workspace.paths.job(key);
  const tex = renderCoverLetter(await template(workspace.paths.coverLetterTemplate, "cover-letter"), letter, profile);
  await writeAtomic(paths.coverLetterTex, tex);
  const compiled = await compileLatex(tex);
  await writeAtomic(paths.coverLetterPdf, compiled.bytes);
  const warnings = compiled.pages > 1 ? [`Cover letter is ${compiled.pages} pages; keep it to one page.`] : [];
  return { pdf: paths.coverLetterPdf, tex: paths.coverLetterTex, pages: compiled.pages, warnings };
}

export async function buildJobDocument(workspace: Workspace, key: JobKey, document: string, input: unknown): Promise<BuiltDocument> {
  const profile = await workspace.getProfile();
  if (!profile) throw new Error("Save a profile before writing job documents");
  const value = await workspace.saveJobDocument(key, document, input);
  const paths = workspace.paths.jobDocument(key, document);
  const tex = renderJobDocument(await template(workspace.paths.documentTemplate, "document"), value, profile);
  await writeAtomic(paths.tex, tex);
  const compiled = await compileLatex(tex);
  await writeAtomic(paths.pdf, compiled.bytes);
  return { pdf: paths.pdf, tex: paths.tex, pages: compiled.pages, warnings: [] };
}
