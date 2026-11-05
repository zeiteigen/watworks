import type { SubmissionRecovery } from "./submission-recovery.js";
import { discardExpiredJobs, jobExpired } from "./queue-maintenance.js";
import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";
import { captureApplication, freezeApplication } from "../../workspace/src/approved-snapshot.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { VERSION } from "../../shared/src/version.js";
import { parseJobKey, type JobKey } from "../../workspace/src/paths.js";
import { attachmentPath, planBlockers } from "../../workspace/src/plans.js";
import { manualApplyLink } from "../../workspace/src/sources/links.js";
import type { ApplicationPlan } from "../../workspace/src/schemas.js";
import type { JobRecord, Workspace } from "../../workspace/src/store.js";
import type { ApplicationForm } from "../../application-workflow/src/types.js";
import { ExtensionCommandProxy } from "../../bridge/src/extension-proxy.js";
import type { Applier } from "./applier.js";
import { DiscoveryPolicySchema } from "../../shared/src/discovery-policy.js";
import { DASHBOARD_PAGE, DASHBOARD_SCRIPT, DASHBOARD_STYLE } from "./page.js";

import { dashboardFont } from "./fonts.js";
import { applicationEvents } from "./application-events.js";

export const DASHBOARD_APP = "wat-dashboard";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-src blob:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" } });
}

function pdf(bytes: Uint8Array): Response {
  return new Response(new Uint8Array(bytes), { headers: { ...SECURITY_HEADERS, "content-type": "application/pdf", "content-length": String(bytes.byteLength) } });
}

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

export interface DashboardBackend {
  recovery?: Pick<SubmissionRecovery, "list" | "release" | "unlockRetry" | "recover">;
  applications?: { refresh(force?: boolean): Promise<import("../../application-workflow/src/types.js").ApplicationInventory>; list?():Promise<import("../../application-workflow/src/types.js").ApplicationInventory> };
  workspace: Workspace;
  applier: Applier;
  discovery?: Pick<ExtensionCommandProxy, "call">;
  submissionStatus?(): Promise<{ connected:boolean; authenticated:boolean;fillOnly:boolean;binding?:string }>;
  health(): Promise<{ authenticated: boolean; bridgeConnected: boolean; bootstrapped: boolean; error?: string }>;
}

/**
 * Hash of everything the user sees before clicking Apply: plan, answers, and
 * the exact PDF bytes. Apply is refused if any of it changed since the page loaded.
 */
async function approvalHash(workspace: Workspace, key: JobKey, plan: ApplicationPlan): Promise<string> {
  const files: Record<string, string> = {};
  const read = async (path: string) => sha256(new Uint8Array(await readFile(path)));
  files.resume = await read(workspace.paths.resume(plan.resumeVariant).pdf).catch(() => "missing");
  for (const attachment of plan.attachments) files[attachment.requirementId] = await read(attachmentPath(workspace, key, attachment)).catch(() => "missing");
  return sha256(JSON.stringify({ plan, files }));
}

function questionLabels(form: ApplicationForm | undefined, plan: ApplicationPlan) {
  return plan.answers.map(answer => {
    const question = form?.questions.find(item => item.id === answer.questionId);
    const label = (id: string) => question?.options?.find(option => option.id === id)?.label ?? id;
    const display = Array.isArray(answer.value) ? answer.value.map(label).join(", ") : typeof answer.value === "string" && question?.options ? label(answer.value) : String(answer.value);
    return { question: question?.label ?? answer.questionId, answer: display };
  });
}

function boundApproval(hash:string,binding:string|undefined):string { return binding ? sha256(JSON.stringify([hash,binding])) : hash; }

async function listItem(backend: DashboardBackend, job: JobRecord, binding?:string) {
  const key = parseJobKey(job.key);
  const pending = backend.applier.pending(key);
  return {
    key: job.key, summary: job.posting.summary, status: job.status, rank: job.plan?.rank ?? null, fit: job.plan?.fit ?? null,
    caveats: job.plan?.caveats ?? [], resumeVariant: job.plan?.resumeVariant ?? null, documents: job.documents,
    active: backend.applier.isActive(key),
    manualApply: manualApplyLink(key.source, key.jobId) ?? null,
    approvalHash: job.plan ? boundApproval(await approvalHash(backend.workspace, key, job.plan),binding) : null,
    ...(pending ? { confirmation: { manifestHash: pending.manifestHash, documents: pending.documents, fillOnly: pending.fillOnly } } : {}),
  };
}

async function detail(backend: DashboardBackend, key: JobKey) {
  const { workspace } = backend;
  const [plan, form, posting, description] = await Promise.all([workspace.getPlan(key), workspace.getForm(key), workspace.getPosting(key), readFile(workspace.paths.job(key).description, "utf8").catch(() => "")]);
  const requirements = form?.requirements.length ? form.requirements.map(({ id, label, required, role }) => ({ id, label, required, role })) : null;
  return {
    description,
    requirements,
    postingRequiredDocuments: posting?.summary.requiredDocuments ?? [],
    questions: form?.questions ?? null,
    formBlockers: form?.blockers ?? [],
    answers: plan ? questionLabels(form, plan) : [],
    attachments: plan?.attachments.map(item => ({ requirementId: item.requirementId, label: form?.requirements.find(slot => slot.id === item.requirementId)?.label ?? item.requirementId, kind: item.kind })) ?? [],
    externalSteps: form?.externalSteps ?? [],
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return undefined;
  const text = await request.text();
  if (Buffer.byteLength(text) > 4096) return undefined;
  const value: unknown = JSON.parse(text || "{}");
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function createDashboardFetch(origin: () => string, backend: DashboardBackend): (request: Request) => Promise<Response> {
  const { workspace, applier } = backend;
  const discovery = backend.discovery ?? new ExtensionCommandProxy();
  const route = async (request: Request): Promise<Response> => {
    try {
      const expected = origin();
      const url = new URL(request.url);
      if (request.headers.get("host") !== new URL(expected).host || url.origin !== expected) return json({ error: "Forbidden host" }, 403);
      const requestOrigin = request.headers.get("origin");
      const extensionOrigin = `chrome-extension://${EXPECTED_EXTENSION_ID}`;
      if (requestOrigin && requestOrigin !== expected && requestOrigin !== extensionOrigin) return json({ error: "Forbidden origin" }, 403);
      if (request.method === "OPTIONS") {
        if (requestOrigin !== extensionOrigin || !url.pathname.startsWith("/api/") ||
          !["GET", "POST"].includes(request.headers.get("access-control-request-method") ?? "") ||
          (request.headers.get("access-control-request-headers") ?? "").split(",").some(header => header.trim() && header.trim().toLowerCase() !== "content-type")) return json({ error: "Forbidden preflight" }, 403);
        return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "Content-Type" } });
      }
      if (request.method === "POST" && requestOrigin !== expected && requestOrigin !== extensionOrigin) return json({ error: "Forbidden origin" }, 403);
      if (request.method === "GET") {
        const font = dashboardFont(url.pathname);
        if (font) return new Response(font, { headers: { ...SECURITY_HEADERS, "content-type": "font/ttf" } });
        if (url.pathname === "/") return new Response(DASHBOARD_PAGE, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/dashboard.js") return new Response(DASHBOARD_SCRIPT, { headers: { ...SECURITY_HEADERS, "content-type": "application/javascript; charset=utf-8" } });
        if (url.pathname === "/dashboard.css") return new Response(DASHBOARD_STYLE, { headers: { ...SECURITY_HEADERS, "content-type": "text/css; charset=utf-8" } });
        if (url.pathname === "/api/ping") return json({ app: DASHBOARD_APP, version: VERSION, dataDir: workspace.paths.root });
        if (url.pathname === "/api/application-events") return applicationEvents(workspace,applier,request.signal);
      }
      if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

      if (url.pathname === "/api/submission-blocks" && request.method === "GET") {
        if (!backend.recovery) return json({ error: "Submission block status is unavailable" }, 503);
        return json({ blocks: await backend.recovery.list() });
      }
      const release = /^\/api\/submission-blocks\/([a-zA-Z0-9-]{1,128})\/release$/.exec(url.pathname);
      if (release && request.method === "POST") {
        if (!backend.recovery) return json({ error: "Submission recovery is unavailable" }, 503);
        const body = await readBody(request);
        if (!body || body.acknowledged !== true || !Number.isSafeInteger(body.updatedAt) || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500) return json({ error: "Confirm the release and provide a reason" }, 400);
        try { backend.recovery.release(release[1]!, body.updatedAt as number, body.reason); }
        catch (error) { return json({ error: error instanceof Error ? error.message : "Block could not be released" }, 409); }
        return json({ released: true, note: "Other jobs are unblocked. The uncertain attempt remains protected against replay. Nothing was submitted." });
      }

      if (url.pathname === "/api/applications" && request.method === "GET") {
        if (!backend.applications) return json({ error: "Applications inventory is unavailable" }, 503);
        try { return json(await (backend.applications.list ? backend.applications.list() : backend.applications.refresh())); }
        catch { return json({ error: "Could not verify applications. Check the WaterlooWorks extension connection." }, 503); }
      }

      if (url.pathname === "/api/discovery-status" && request.method === "GET") {
        try { return json(await discovery.call("discoveryStatus")); } catch { return json({ error: "Discovery status unavailable" }, 503); }
      }
      if (url.pathname === "/api/discoveries" && request.method === "GET") {
        try { return json({ discoveries: await discovery.call("discoveriesList") }); }
        catch { return json({ error: "Daily discovery is unavailable because the browser extension is offline. Reload the extension and retry." }, 503); }
      }
      if (url.pathname === "/api/discovery-policy" && request.method === "GET") {
        try { return json({ policy: await discovery.call("discoveryPolicyGet") }); }
        catch { return json({ error: "Discovery settings are unavailable because the browser extension is offline. Reload the extension and retry." }, 503); }
      }
      if (url.pathname === "/api/discovery-policy" && request.method === "POST") {
        const body = await readBody(request);
        const parsed = body && DiscoveryPolicySchema.safeParse(body.policy);
        if (!parsed?.success) return json({ error: "Invalid discovery policy" }, 400);
        try { return json({ policy: await discovery.call("discoveryPolicySave", parsed.data) }); }
        catch { return json({ error: "Discovery settings could not be saved because the browser extension is offline. Reload the extension and retry." }, 503); }
      }

      if (request.method === "GET" && url.pathname === "/api/materials") {
        const [resumes, jobs] = await Promise.all([workspace.listResumeVariants(), workspace.listJobs()]);
        return json({
          resumes: resumes.map(({ variant, pdf: file }) => ({ id: variant.variant, label: variant.label, available: Boolean(file) })),
          documents: jobs.flatMap(job => job.documents.map(document => ({
            id: document.id, key: job.key, title: document.title, kind: document.kind, state: job.status.state,
          }))),
        });
      }
      const resumeMatch = /^\/api\/materials\/resumes\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
      if (request.method === "GET" && resumeMatch) {
        const bytes = await readFile(workspace.paths.resume(resumeMatch[1]!).pdf).catch(() => undefined);
        return bytes ? pdf(new Uint8Array(bytes)) : json({ error: "Document not found" }, 404);
      }
      const materialMatch = /^\/api\/materials\/jobs\/([a-z0-9-]+)\/([A-Za-z0-9_-]{1,64})\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
      if (request.method === "GET" && materialMatch) {
        const key = parseJobKey(`${materialMatch[1]}:${materialMatch[2]}`);
        const status = await workspace.getStatus(key);
        if (!status) return json({ error: "Unknown job" }, 404);
        const docId = materialMatch[3]!;
        const record = await workspace.listJobs();
        const doc = record.find(job => job.key === `${key.source}:${key.jobId}`)?.documents.find(item => item.id === docId);
        if (!doc) return json({ error: "Document not found" }, 404);
        const path = doc.kind === "cover_letter" ? workspace.paths.job(key).coverLetterPdf : workspace.paths.jobDocument(key, docId).pdf;
        const bytes = await readFile(path).catch(() => undefined);
        return bytes ? pdf(new Uint8Array(bytes)) : json({ error: "Document not found" }, 404);
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        await discardExpiredJobs(workspace, key => applier.isActive(key));
        const [health, jobs, profile, submission] = await Promise.all([
          backend.health().catch(error => ({ authenticated: false, bridgeConnected: false, bootstrapped: false, error: String(error) })),
          workspace.listJobs(), workspace.getProfile().catch(() => undefined),
          backend.submissionStatus?.().catch(()=>({connected:false,authenticated:false,fillOnly:false,binding:undefined})),
        ]);
        return json({ health, ...(submission ? {submission} : {}), ...(backend.recovery ? { submissionBlocks: await backend.recovery.list() } : {}), profile: profile ? { name: profile.name } : null, jobs: await Promise.all(jobs.map(job => listItem(backend, job, submission?.binding))) });
      }

      const match = /^\/api\/jobs\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)(?:\/(apply|confirm|remove|requeue|recheck|unlock-retry|recover)|\/files\/(resume|cover-letter|doc-[a-z0-9-]+|processed-[A-Za-z0-9_-]+))?$/.exec(url.pathname);
      if (!match) return json({ error: "Not found" }, 404);
      const key = parseJobKey(`${match[1]}:${match[2]}`);
      const status = await workspace.getStatus(key);
      if (!status) return json({ error: "Unknown job" }, 404);

      if (request.method === "GET" && match[4]) {
        const file = match[4];
        if (file.startsWith("processed-")) {
          const bytes = applier.documentBytes(key, file.slice("processed-".length));
          return bytes ? pdf(bytes) : json({ error: "Document not found" }, 404);
        }
        const plan = await workspace.getPlan(key);
        const path = file === "resume" ? plan && workspace.paths.resume(plan.resumeVariant).pdf
          : file.startsWith("doc-") ? workspace.paths.jobDocument(key, file.slice("doc-".length)).pdf
            : workspace.paths.job(key).coverLetterPdf;
        const bytes = path ? await readFile(path).catch(() => undefined) : undefined;
        return bytes ? pdf(new Uint8Array(bytes)) : json({ error: "Document not found" }, 404);
      }
      if (request.method === "GET" && !match[3]) return json(await detail(backend, key));

      if (request.method === "POST" && match[3]) {
        if (["apply", "confirm", "requeue", "recheck", "unlock-retry"].includes(match[3])) {
          const posting = await workspace.getPosting(key);
          if (posting && await jobExpired(workspace, { key: `${key.source}:${key.jobId}`, posting })) {
            await discardExpiredJobs(workspace, item => applier.isActive(item));
            return json({ error: "The application deadline has passed. This job cannot be restored or submitted." }, 409);
          }
        }
        const body = await readBody(request);
        if (!body) return json({ error: "Invalid request" }, 400);
        if (["remove", "requeue", "recheck", "recover"].includes(match[3]) && applier.isActive(key)) return json({ error: "This application is already queued or submitting" }, 409);
        if (status.removedFromQueueAt && ["apply", "confirm", "recheck"].includes(match[3])) return json({ error: "Restore this job to the queue first" }, 409);
        switch (match[3]) {
          case "recover": {
            if (!backend.recovery) return json({ error: "Submission recovery is unavailable" }, 503);
            if (body.acknowledged !== true || body.updatedAt !== status.updatedAt || !["failed", "outcome_unknown", "planned", "found"].includes(status.state) || status.removedFromQueueAt) return json({ error: "Review the current job before checking its application" }, 409);
            try { return json({ status: await backend.recovery.recover(key, status.updatedAt) }); }
            catch (error) { return json({ error: error instanceof Error ? error.message : "Could not check this application" }, 409); }
          }
          case "unlock-retry": {
            if (!backend.recovery) return json({ error: "Submission recovery is unavailable" }, 503);
            if (body.acknowledged !== true || body.updatedAt !== status.updatedAt) return json({ error: "Confirm the retry check on the current application" }, 409);
            if (!["failed", "outcome_unknown"].includes(status.state) || applier.hasActive || status.removedFromQueueAt) return json({ error: "Wait for active applications to finish before checking this retry" }, 409);
            try { await backend.recovery.unlockRetry(key); }
            catch (error) { return json({ error: error instanceof Error ? error.message : "Retry remains locked" }, 409); }
            const plan = await workspace.getPlan(key);
            const blockers = plan ? await planBlockers(workspace, key, plan, await workspace.getForm(key)) : ["No saved application plan"];
            return json({ status: await workspace.setStatus(key, { state: blockers.length ? "planned" : "ready", blockers,
              reason: "WaterlooWorks verified no application. Retry unlocked by your request; review and approve a new attempt. Nothing was submitted." }) });
          }
          case "recheck": {
            if (status.state !== "failed") return json({ error: "Only failed jobs can be rechecked" }, 409);
            const plan = await workspace.getPlan(key);
            if (!plan) return json({ error: "No saved application plan" }, 409);
            const blockers = await planBlockers(workspace, key, plan, await workspace.getForm(key));
            return json({ status: await workspace.setStatus(key, blockers.length ? { state: "planned", blockers } : { state: "ready" }) });
          }
          case "remove":
          case "requeue":
            if (match[3] === "remove" && !["found", "planned", "ready", "failed", "skipped"].includes(status.state)) return json({ error: `This job is ${status.state} and cannot be removed from the queue` }, 409);
            if (match[3] === "requeue" && status.state === "skipped") {
              const plan = await workspace.getPlan(key);
              const blockers = plan ? await planBlockers(workspace, key, plan, await workspace.getForm(key)) : [];
              await workspace.setStatus(key, { state: plan ? blockers.length ? "planned" : "ready" : "found", blockers });
            }
            return json({ status: await workspace.setQueueRemoved(key, match[3] === "remove") });
          case "apply": {
            if (body.executionMode !== undefined && body.executionMode !== "submit" && body.executionMode !== "fill_only") return json({ error: "Invalid application mode" }, 400);
            const plan = await workspace.getPlan(key);
            if (!plan || (await workspace.getStatus(key))?.removedFromQueueAt || applier.isActive(key) || (status.state !== "ready" && status.state !== "failed")) return json({ error: `This job is ${status.state} and cannot be applied to` }, 409);
            const submission=await backend.submissionStatus?.();
            if (submission && (!submission.connected || !submission.authenticated || !submission.binding)) return json({error:"Connect the submission server and transfer your WaterlooWorks session first"},409);
            if (submission && body.executionMode === "fill_only" && !submission.fillOnly) return json({error:"Fill form only is unavailable on this server"},409);
            const captured=await captureApplication(workspace,key,plan);
            if (typeof body.approvalHash !== "string" || body.approvalHash !== boundApproval(captured.hash,submission?.binding)) return json({ error: "This application changed since the page loaded. Review it again." }, 409);
            const snapshot=await freezeApplication(workspace,captured);
            if(applier.isActive(key) || (await workspace.getStatus(key))?.removedFromQueueAt){await snapshot.dispose();return json({error:"Application is already queued or was removed"},409);}
            applier.enqueue(key, item => applier.apply(item,snapshot,body.executionMode === "fill_only" ? "fill_only" : "submit",submission?.binding));
            return json({ queued: true }, 202);
          }
          case "confirm":
            if (typeof body.manifestHash !== "string" || status.state !== "confirm_required") return json({ error: "Nothing to confirm" }, 409);
            applier.enqueue(key, item => applier.confirm(item, body.manifestHash as string));
            return json({ queued: true }, 202);
        }
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
    }
  };
  return async request => {
    const response = await route(request);
    if (request.headers.get("origin") === `chrome-extension://${EXPECTED_EXTENSION_ID}`) {
      response.headers.set("access-control-allow-origin", `chrome-extension://${EXPECTED_EXTENSION_ID}`);
      response.headers.set("vary", "Origin");
    }
    return response;
  };
}
