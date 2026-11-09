import { WRITE_APPROVAL_ACTIONS, writeApprovalTokenSchema, type WriteApprovalAction } from "../../shared/src/extension-protocol.js";
import { BrowserOperationError } from "../../shared/src/operation-failure.js";

/**
 * Human approval capabilities. Only an extension page can mint one, on the user's
 * click, so a process that merely reaches the loopback services cannot obtain it.
 * Session storage survives a service-worker restart and is closed to content scripts.
 */
const STORE = "write-approvals";
const TTL_MS = 15 * 60_000;
const MAX_RECORDS = 256;
/** One click covers the resume upload and one staging pass, then a single submission. */
const MAX_UPLOADS = 2;
const MAX_STAGES = 1;
const JOB_TARGET = /^waterlooworks:([A-Za-z0-9_-]{1,64})$/;
const BLOCK_TARGET = /^[a-zA-Z0-9-]{1,128}$/;

interface ApprovalRecord { action: WriteApprovalAction; target: string; expiresAt: number; uploads: number; stages: number }
type Approvals = Record<string, ApprovalRecord>;

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

async function load(): Promise<Approvals> {
  const stored = (await chrome.storage.session.get(STORE))[STORE] as Approvals | undefined;
  const now = Date.now();
  return Object.fromEntries(Object.entries(stored ?? {}).filter(([, record]) => record.expiresAt > now));
}
function save(approvals: Approvals): Promise<void> { return chrome.storage.session.set({ [STORE]: approvals }); }

/** Only a digest is stored, so reading the store does not yield a usable approval. */
async function digest(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function validTarget(action: WriteApprovalAction, target: unknown): target is string {
  return typeof target === "string" && (action === "release" ? BLOCK_TARGET : JOB_TARGET).test(target);
}

/** Called only for messages that passed background.ts's extension-page sender check. */
export async function mintWriteApproval(action: unknown, target: unknown): Promise<{ token: string; expiresAt: number }> {
  if (!WRITE_APPROVAL_ACTIONS.includes(action as WriteApprovalAction) || !validTarget(action as WriteApprovalAction, target)) throw new Error("Invalid write approval request");
  return serialized(async () => {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const approvals = await load();
    if (Object.keys(approvals).length >= MAX_RECORDS) throw new Error("Too many pending approvals; wait for them to expire");
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const expiresAt = Date.now() + TTL_MS;
    approvals[await digest(token)] = { action: action as WriteApprovalAction, target, expiresAt, uploads: 0, stages: 0 };
    await save(approvals);
    return { token, expiresAt };
  });
}

/** Read-only check used by the dashboard service before it changes any state. */
export function verifyWriteApproval(token: unknown, action: unknown, target: unknown): Promise<{ valid: boolean }> {
  return serialized(async () => {
    if (!writeApprovalTokenSchema.safeParse(token).success) return { valid: false };
    const record = (await load())[await digest(token as string)];
    return { valid: record?.action === action && record?.target === target };
  });
}

function refuse(message: string): BrowserOperationError {
  return new BrowserOperationError({ phase: "preflight", code: "no_remote_mutation", message });
}

/**
 * Gate every WaterlooWorks mutation. A refusal proves nothing was dispatched.
 * An allowed call spends its allowance before dispatch, so it can never be replayed.
 */
export function authorizeWrite(method: string, args: readonly unknown[], token: unknown): Promise<void> {
  return serialized(async () => {
    if (method === "setDefaultDocuments") throw refuse("Changing global default documents is unsupported");
    const parsed = writeApprovalTokenSchema.safeParse(token);
    if (!parsed.success) throw refuse("This write needs an approval from the extension dashboard");
    const approvals = await load();
    const key = await digest(parsed.data);
    const record = approvals[key];
    if (!record || record.action !== "apply") throw refuse("This write's approval is invalid or expired; approve it again in the extension dashboard");
    if (method === "uploadDocument") {
      if (record.uploads >= MAX_UPLOADS) throw refuse("This approval's upload allowance is spent; approve it again in the extension dashboard");
      record.uploads++;
    } else {
      const jobId = JOB_TARGET.exec(record.target)?.[1];
      const manifest = args[0] as { jobId?: unknown } | null | undefined;
      if (!jobId || manifest?.jobId !== jobId) throw refuse("This write's approval is for a different job");
      if (method === "stageAttachments") {
        if (record.stages >= MAX_STAGES) throw refuse("This approval's staging allowance is spent; approve it again in the extension dashboard");
        record.stages++;
      } else if (method === "submitApplication" || method === "fillApplication") delete approvals[key];
      else throw refuse("Unsupported write");
    }
    await save(approvals);
  });
}
