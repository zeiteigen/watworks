import { parsePageLiteral } from "./bootstrap.js";
import { ProtocolChangedError } from "./errors.js";
import type { ApplicationRecord } from "../../application-workflow/src/types.js";

/** Only the read-only DataViewer request, never cancellation or other page actions. */
export function applicationListRequest(html: string): Record<string, string> {
  const declarations = [...html.matchAll(/\b(const|let|var)\s+request\s*=\s*(\{[^{}]*\})\s*;/g)];
  const blocks = declarations.flatMap(match => {
    try { return [parsePageLiteral(match[2]!) as Record<string, unknown>]; }
    catch { return []; } // An unrelated dynamic page action is not our read request.
  });
  const candidates = blocks.filter(value => typeof value.action === "string" && value.studentId && value.postingModuleId && value.selectedTerm);
  if (candidates.length !== 1) throw new ProtocolChangedError(`Applications list request changed (literal declarations: ${declarations.length}, list candidates: ${candidates.length})`);
  const request = candidates[0]!;
  const allowed = ["action", "studentId", "postingModuleId", "selectedTerm", "numOfDays", "status"];
  if (Object.keys(request).some(key => !allowed.includes(key))) throw new ProtocolChangedError("Applications list parameters changed");
  return Object.fromEntries(Object.entries(request).map(([key, value]) => {
    if (typeof value !== "string" && typeof value !== "number") throw new ProtocolChangedError("Invalid applications list parameter");
    return [key, String(value)];
  }));
}

export function parseApplications(value: unknown): { total: number; applications: ApplicationRecord[] } {
  const raw = value as { totalResults?: unknown; data?: unknown };
  if (!raw || !Number.isSafeInteger(raw.totalResults) || Number(raw.totalResults) < 0 || !Array.isArray(raw.data)) throw new ProtocolChangedError("Invalid applications list");
  const applications = raw.data.map((row: { id?: unknown; data?: unknown }) => {
    if (!row || !Array.isArray(row.data)) throw new ProtocolChangedError("Invalid application row");
    const fields: Record<string, unknown> = {};
    for (const item of row.data) {
      if (!item || typeof item.key !== "string" || Object.hasOwn(fields, item.key)) throw new ProtocolChangedError("Invalid application field");
      fields[item.key] = item.value;
    }
    const id = (value: unknown) => { const text = String(value ?? ""); if (!/^[1-9]\d*$/.test(text)) throw new ProtocolChangedError("Invalid application identifier"); return text; };
    const text = (key: string) => { if (typeof fields[key] !== "string" || !fields[key]) throw new ProtocolChangedError(`Missing application ${key}`); return fields[key] as string; };
    const submittedAt = text("applicationSubmittedOn");
    if (!Number.isFinite(Date.parse(submittedAt))) throw new ProtocolChangedError("Invalid application submission time");
    return { applicationId: id(row.id), jobId: id(fields.jobId), title: text("jobTitle"), employer: text("organization"), term: text("term"),
      status: text("applicationStatus"), ...(typeof fields.jobStatus === "string" && fields.jobStatus.trim() ? { jobStatus: fields.jobStatus.trim() } : {}), submittedAt, location: typeof fields.city === "string" ? fields.city : "" };
  });
  return { total: Number(raw.totalResults), applications };
}
