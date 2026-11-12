import { z } from "zod";
import { applicationProgressSchema } from "./application-progress.js";

export const EXTENSION_PROTOCOL_VERSION = 1 as const;
/** Stable unpacked ID derived from the extension manifest public key. */
export const EXPECTED_EXTENSION_ID = "onlcepldlajaajfjldnbipkbffaficjh";
export const EXTENSION_METHODS = [
  "localApplicationRead",
  "getSubmissionStatus",
  "submissionCommand",
  "bootstrap",
  "health",
  "searchJobs",
  "getJob",
  "getSearchMetadata",
  "getAccountOverview",
  "getDocumentMetadata",
  "getEmployerReport",
  "getApplicationForm",
  "listDocuments",
  "getDocument",
  "getDocumentSnapshot",
  "getAccount",
  "getApplicationStatus",
  "listApplications",
  "uploadDocument",
  "stageAttachments",
  "submitApplication",
  "fillApplication",
  "setDefaultDocuments",
  "discoveryPolicyGet",
  "discoveryPolicySave",
  "discoveriesList",
  "discoveryStatus",
  "getOperationProgress",
  "verifyWriteApproval",
] as const;
export type ExtensionMethod = (typeof EXTENSION_METHODS)[number];

/** Human decisions that an extension page approves by minting a write approval. */
export const WRITE_APPROVAL_ACTIONS = ["apply", "recover", "unlock-retry", "release"] as const;
export type WriteApprovalAction = (typeof WRITE_APPROVAL_ACTIONS)[number];
export const writeApprovalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const writeApprovalTargetSchema = z.string().min(1).max(200);

/** Methods that change WaterlooWorks; the extension refuses them without a click-minted approval. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["uploadDocument", "stageAttachments", "submitApplication", "fillApplication", "setDefaultDocuments"]);

/** The method a command really runs, seeing through the pinned submissionCommand envelope. */
export function effectiveCommand(method: string, args: readonly unknown[]): { method: string; args: readonly unknown[] } {
  if (method !== "submissionCommand") return { method, args };
  return { method: typeof args[1] === "string" ? args[1] : "", args: Array.isArray(args[2]) ? args[2] : [] };
}
export const extensionHelloSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.literal(1),
    extensionVersion: z.string().max(64),
    capabilities: z.array(z.string().max(80)).max(64),
    accountKey: z.string().max(200).optional(),
  })
  .strict();
export const extensionResultSchema = z
  .object({
    type: z.literal("result"),
    requestId: z.string().uuid(),
    result: z.unknown().optional(),
    error: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    (value) => (value.error === undefined) !== (value.result === undefined),
    "result must contain exactly one of result or error",
  );
export const extensionProgressSchema = z
  .object({
    type: z.literal("progress"),
    requestId: z.string().uuid(),
    progress: applicationProgressSchema,
  })
  .strict();
export const extensionCommandSchema = z
  .object({
    type: z.literal("command"),
    requestId: z.string().uuid(),
    method: z.enum(EXTENSION_METHODS),
    args: z.array(z.unknown()).max(32),
    deadline: z.number().int().positive(),
    streamProgress: z.literal(true).optional(),
    approval: writeApprovalTokenSchema.optional(),
  })
  .strict();
export const localCommandSchema = z
  .object({
    method: z.enum(EXTENSION_METHODS),
    args: z.array(z.unknown()).max(32),
    approval: writeApprovalTokenSchema.optional(),
  })
  .strict();
export const localCommandResponseSchema = z.union([
  z.object({ result: z.unknown() }).strict(),
  z.object({ error: z.string().min(1).max(1000) }).strict(),
]);

const emptyArgs = z.tuple([]);
const stringArg = z.tuple([z.string().min(1).max(500)]);
const optionalObjectArg = z.union([
  emptyArgs,
  z.tuple([z.record(z.string(), z.unknown())]),
]);
const methodArgs: Record<ExtensionMethod, z.ZodType<unknown[]>> = {
  localApplicationRead: z.tuple([
    z.enum([
      "getAccount",
      "getApplicationForm",
      "getApplicationStatus",
      "listApplications",
      "listDocuments",
      "getDocument",
      "getDocumentSnapshot",
    ]),
    z.array(z.unknown()).max(1),
  ]),
  getSubmissionStatus: emptyArgs,
  verifyWriteApproval: z.tuple([
    writeApprovalTokenSchema,
    z.enum(WRITE_APPROVAL_ACTIONS),
    writeApprovalTargetSchema,
  ]),
  submissionCommand: z.tuple([
    z.string().regex(/^[a-f0-9]{64}$/),
    z.string().max(80),
    z.array(z.unknown()).max(8),
  ]),
  bootstrap: emptyArgs,
  health: emptyArgs,
  getSearchMetadata: emptyArgs,
  getDocumentMetadata: emptyArgs,
  listDocuments: emptyArgs,
  listApplications: emptyArgs,
  getAccount: emptyArgs,
  discoveryPolicyGet: emptyArgs,
  discoveriesList: emptyArgs,
  discoveryStatus: emptyArgs,
  searchJobs: optionalObjectArg,
  getJob: z.union([
    stringArg,
    z.tuple([z.string().min(1).max(500), z.record(z.string(), z.unknown())]),
  ]),
  getAccountOverview: optionalObjectArg,
  getEmployerReport: stringArg,
  getApplicationForm: stringArg,
  getDocument: stringArg,
  getDocumentSnapshot: stringArg,
  getApplicationStatus: stringArg,
  getOperationProgress: z.tuple([z.string().uuid()]),
  uploadDocument: z.tuple([
    z.string().min(1).max(200),
    z.string().min(1).max(500),
    z.record(z.string(), z.unknown()),
    z.string().min(1).max(200),
    z.string().uuid().optional(),
  ]),
  stageAttachments: z.tuple([
    z.record(z.string(), z.unknown()),
    z.array(z.tuple([z.string().max(500), z.record(z.string(), z.unknown())])).max(100),
  ]),
  fillApplication: z.tuple([
    z.record(z.string(), z.unknown()),
    z.array(z.tuple([z.string().max(500), z.record(z.string(), z.unknown())])).max(100),
    z.array(z.record(z.string(), z.unknown())).max(100),
  ]),
  submitApplication: z.union([
    z.tuple([
      z.record(z.string(), z.unknown()),
      z.array(z.tuple([z.string().max(500), z.record(z.string(), z.unknown())])).max(100),
    ]),
    z.tuple([
      z.record(z.string(), z.unknown()),
      z.array(z.tuple([z.string().max(500), z.record(z.string(), z.unknown())])).max(100),
      z.array(z.record(z.string(), z.unknown())).max(100),
    ]),
  ]),
  setDefaultDocuments: z.tuple([
    z.string().min(1).max(200),
    z.array(z.string().max(500)).max(500),
    z.string().min(1).max(200),
  ]),
  discoveryPolicySave: z.tuple([z.record(z.string(), z.unknown())]),
};

export function validateExtensionArgs(
  method: ExtensionMethod,
  args: unknown[],
): boolean {
  return (
    isBoundedExtensionValue(args) && methodArgs[method].safeParse(args).success
  );
}

export function isBoundedExtensionValue(
  value: unknown,
  maxNodes = 200_000,
  maxDepth = 64,
): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++nodes > maxNodes || current.depth > maxDepth) return false;
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    )
      continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        if (key.length > 10_000) return false;
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    return false;
  }
  return true;
}
