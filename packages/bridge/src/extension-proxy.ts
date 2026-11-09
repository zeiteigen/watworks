import { isBase64 } from "../../shared/src/base64.js";
import { submissionBindingScope } from "./submission-binding.js";
import type { WaterlooWorksClient } from "../../waterlooworks-client/src/client.js";
import { applicationProgressSchema, type ApplicationProgress } from "../../shared/src/application-progress.js";
import { readCommandStream, COMMAND_STREAM_TYPE } from "../../shared/src/command-stream.js";
import { BrowserOperationError, decodeOperationFailure } from "../../shared/src/operation-failure.js";
import { ReviewBeforeMutationError } from "../../approval/src/types.js";
import type { ApplicationGateway } from "../../application-workflow/src/types.js";
import { localCommandResponseSchema, type ExtensionMethod } from "../../shared/src/extension-protocol.js";

export type ResearchClient = Pick<WaterlooWorksClient, "bootstrap" | "searchJobs" | "getSearchMetadata" | "getJob" | "getAccountOverview" | "getDocumentMetadata" | "getEmployerReport" | "health">;
const MAX_HTTP_BYTES = 48 * 1024 * 1024;

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array ? { $bytes: Buffer.from(item).toString("base64") } : item);
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$bytes === "string" && Object.keys(record).length === 1) {
      if (!isBase64(record.$bytes)) throw new Error("Extension bridge returned invalid byte data");
      return new Uint8Array(Buffer.from(record.$bytes, "base64"));
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decode(child)]));
  }
  return value;
}

async function readBoundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_HTTP_BYTES) { await response.body?.cancel(); throw new Error("Extension bridge response is too large"); }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTTP_BYTES) { await reader.cancel(); throw new Error("Extension bridge response is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export class ExtensionCommandProxy {
  constructor(private readonly baseUrl = "http://127.0.0.1:39451") {}
  async call<T>(method: ExtensionMethod, ...args: unknown[]): Promise<T> {
    return this.perform(method,args);
  }
  async callWithProgress<T>(method:ExtensionMethod,args:unknown[],onProgress:(progress:ApplicationProgress)=>void,approval?:string):Promise<T>{
    return this.perform(method,args,onProgress,approval);
  }
  private async perform<T>(method:ExtensionMethod,args:unknown[],onProgress?:(progress:ApplicationProgress)=>void,approval?:string):Promise<T>{
    let response: Response;
    const timeout = method === "getOperationProgress" ? 1500 : ["submissionCommand", "uploadDocument", "stageAttachments", "submitApplication", "fillApplication", "setDefaultDocuments", "discoveryPolicySave"].includes(method) ? 185_000 : 35_000;
    try { response = await fetch(`${this.baseUrl}/command`, { method: "POST", headers: { "content-type": "application/json",...(onProgress?{accept:COMMAND_STREAM_TYPE}:{}) }, body: encode({ method, args, ...(approval?{approval}:{}) }), signal: AbortSignal.timeout(timeout) }); }
    catch { throw new Error("WaterlooWorks extension bridge is unavailable"); }
    let body: unknown;
    try { body = response.headers.get("content-type")?.startsWith(COMMAND_STREAM_TYPE) ? await readCommandStream(response,onProgress) : JSON.parse(await readBoundedText(response)); } catch (error) {
      if (error instanceof Error && error.message === "Extension bridge response is too large") throw error;
      throw new Error(`Extension bridge returned invalid JSON (${response.status})`);
    }
    const envelope = localCommandResponseSchema.safeParse(body);
    if (!envelope.success) throw new Error(`Extension bridge returned an invalid response (${response.status})`);
    if ("error" in envelope.data) {
      const failure = decodeOperationFailure(envelope.data.error);
      if (failure) throw new BrowserOperationError(failure);
      throw new Error(envelope.data.error);
    }
    if (!response.ok) throw new Error(`Extension bridge returned HTTP ${response.status}`);
    return decode(envelope.data.result) as T;
  }
}

/** Drop-in read adapter for the semantic research methods on WaterlooWorksClient. */
export class ExtensionResearchClient implements ResearchClient {
  constructor(private readonly proxy = new ExtensionCommandProxy()) {}
  bootstrap(): Promise<void> { return this.proxy.call("bootstrap"); }
  searchJobs(query = {}): ReturnType<WaterlooWorksClient["searchJobs"]> { return this.proxy.call("searchJobs", query); }
  getSearchMetadata(): ReturnType<WaterlooWorksClient["getSearchMetadata"]> { return this.proxy.call("getSearchMetadata"); }
  getJob(jobId: string, options = {}): ReturnType<WaterlooWorksClient["getJob"]> { return this.proxy.call("getJob", jobId, options); }
  getAccountOverview(options = {}): ReturnType<WaterlooWorksClient["getAccountOverview"]> { return this.proxy.call("getAccountOverview", options); }
  getDocumentMetadata(): ReturnType<WaterlooWorksClient["getDocumentMetadata"]> { return this.proxy.call("getDocumentMetadata"); }
  getEmployerReport(companyId: string): ReturnType<WaterlooWorksClient["getEmployerReport"]> { return this.proxy.call("getEmployerReport", companyId); }
  async health(): ReturnType<WaterlooWorksClient["health"]> {
    try { return await this.proxy.call("health"); }
    catch (error) {
      return { authenticated: false, bridgeConnected: false, bootstrapped: false, error: error instanceof Error ? error.message : "Extension bridge is unavailable" };
    }
  }
}

class SubmissionCommandProxy extends ExtensionCommandProxy {
  override async callWithProgress<T>(method:ExtensionMethod,args:unknown[],onProgress:(progress:ApplicationProgress)=>void,approval?:string):Promise<T>{
    const binding=submissionBindingScope.getStore();
    return binding?super.callWithProgress<T>("submissionCommand",[binding,method,args],onProgress,approval):super.callWithProgress<T>(method,args,onProgress,approval);
  }
  override async call<T>(method: ExtensionMethod, ...args: unknown[]): Promise<T> {
    const binding = submissionBindingScope.getStore();
    if (!binding) return super.call<T>(method,...args);
    return super.call<T>("submissionCommand",binding,method,args);
  }
}
/** Chrome handles preparation reads locally; bound operations and writes use the submission server. */
export class ExtensionApplicationGateway implements ApplicationGateway {
  private readonly progressListeners=new Map<string,Set<(progress:ApplicationProgress)=>void>>();
  watchOperationProgress(operationId:string,listener:(progress:ApplicationProgress)=>void):()=>void{
    let listeners=this.progressListeners.get(operationId);
    if(!listeners){listeners=new Set();this.progressListeners.set(operationId,listeners);}
    listeners.add(listener);
    return ()=>{listeners.delete(listener);if(!listeners.size)this.progressListeners.delete(operationId);};
  }
  private command<T>(method:ExtensionMethod,args:unknown[],attemptId?:string,approval?:string):Promise<T>{
    if(!attemptId || typeof this.proxy.callWithProgress!=="function")return this.proxy.call<T>(method,...args);
    return this.proxy.callWithProgress<T>(method,args,progress=>{
      for(const listener of this.progressListeners.get(attemptId)??[])try{listener(progress);}catch{/* Telemetry cannot fail an approved write. */}
    },approval);
  }
  async getOperationProgress(operationId: string) { return applicationProgressSchema.nullable().parse(await this.proxy.call("getOperationProgress", operationId)); }
  listApplications(): Promise<import("../../application-workflow/src/types.js").ApplicationInventory> { return this.proxy.call("listApplications"); }
  readonly capabilities = { upload: true, defaults: false, submit: true, reason: "Setting default documents is not currently supported through the extension" };
  constructor(private readonly proxy = new SubmissionCommandProxy()) {}
  async withMutationTracking<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof BrowserOperationError && error.failure.code === "no_remote_mutation") {
        throw new ReviewBeforeMutationError(error.message, undefined, "no_remote_mutation", error.failure);
      }
      throw error;
    }
  }
  getApplicationForm(jobId: string): ReturnType<ApplicationGateway["getApplicationForm"]> { return this.proxy.call("getApplicationForm", jobId); }
  listDocuments(): ReturnType<ApplicationGateway["listDocuments"]> { return this.proxy.call("listDocuments"); }
  getDocument(documentId: string): NonNullable<ApplicationGateway["getDocument"]> extends (...args: never[]) => infer R ? R : never { return this.proxy.call("getDocument", documentId); }
  getDocumentSnapshot(documentId: string): NonNullable<ApplicationGateway["getDocumentSnapshot"]> extends (...args: never[]) => infer R ? R : never { return this.proxy.call("getDocumentSnapshot", documentId); }
  stageAttachments(manifest: Parameters<NonNullable<ApplicationGateway["stageAttachments"]>>[0], files: Parameters<NonNullable<ApplicationGateway["stageAttachments"]>>[1], attemptId?: string, approval?: string): ReturnType<NonNullable<ApplicationGateway["stageAttachments"]>> { return this.command("stageAttachments",[attemptId ? {...manifest, executionAttemptId:attemptId} : manifest, [...files]],attemptId,approval); }
  getAccount(): ReturnType<ApplicationGateway["getAccount"]> { return this.proxy.call("getAccount"); }
  uploadDocument(typeId: string, name: string, file: Parameters<ApplicationGateway["uploadDocument"]>[2], accountKey: string, attemptId?: string, approval?: string): ReturnType<ApplicationGateway["uploadDocument"]> { return this.command("uploadDocument",[typeId,name,file,accountKey,...(attemptId?[attemptId]:[])],attemptId,approval); }
  setDefaultDocuments(typeId: string, documentIds: string[], accountKey: string): ReturnType<ApplicationGateway["setDefaultDocuments"]> { return this.proxy.call("setDefaultDocuments", typeId, documentIds, accountKey); }
  async submitApplication(...args: Parameters<ApplicationGateway["submitApplication"]>): ReturnType<ApplicationGateway["submitApplication"]> {
    const [manifest, files, beforeFinalSubmit, staged, attemptId, approval] = args;
    beforeFinalSubmit();
    // Keep the established argument shape for existing broker owners. This
    // transport-only identity is removed before the approved manifest is used.
    if (manifest.executionMode === "fill_only") return this.command("fillApplication",[attemptId ? { ...manifest, executionAttemptId: attemptId } : manifest, [...files], staged ?? []],attemptId,approval);
    if (attemptId) return this.command("submitApplication", [{ ...manifest, executionAttemptId: attemptId }, [...files], staged ?? []],attemptId,approval);
    return staged === undefined ? this.proxy.call("submitApplication", manifest, [...files]) : this.proxy.call("submitApplication", manifest, [...files], staged);
  }
  getApplicationStatus(jobId: string): ReturnType<ApplicationGateway["getApplicationStatus"]> { return this.proxy.call("getApplicationStatus", jobId); }
}
