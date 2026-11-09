import { effectiveCommand, MUTATING_METHODS, validateExtensionArgs, type ExtensionMethod } from "../../shared/src/extension-protocol.js";
import { withSignInRecovery } from "./command-auth.js";
import { browserFetch, browserResearch } from "./research.js";
import { authorizeWrite, verifyWriteApproval } from "./write-approval.js";
import { BrowserApplicationReads } from "./application-reads.js";
import { callSubmission, getSubmissionStatus } from "./submission-client.js";
import { discoveryStatus, discoveriesList, runDiscovery } from "./discovery.js";
import { policyGet, policySave } from "./discovery-policy.js";
import { clearSignInEpisode } from "./signin.js";
import { browserDiagnostics } from "./browser-diagnostics.js";
import { lastTabInspection } from "./tab-inspection.js";
import { EXTENSION_BUILD } from "./build-info.js";
import type { ApplicationProgress } from "../../shared/src/application-progress.js";

export const reads = new BrowserApplicationReads(browserFetch);
const localReads:Record<string,(...args:any[])=>Promise<unknown>> = {
  getAccount:()=>reads.getAccount(),getApplicationForm:id=>reads.getApplicationForm(id),
  getApplicationStatus:id=>reads.getApplicationStatus(id),listApplications:()=>reads.listApplications(),
  listDocuments:()=>reads.listDocuments(),getDocument:id=>reads.getDocument(id),getDocumentSnapshot:id=>reads.getDocumentSnapshot(id),
};
function localRead(method:string,args:unknown[],recoverSignIn=true):Promise<unknown> {
  const read=Object.hasOwn(localReads,method)?localReads[method]:undefined;
  if(!read || !Array.isArray(args) || !validateExtensionArgs(method as ExtensionMethod,args))throw new Error("Unsupported local application read");
  return recoverSignIn ? withSignInRecovery(method,()=>read(...args)) : read(...args);
}
const applicationMethods = new Set(["getAccount","getApplicationForm","getApplicationStatus","listApplications","listDocuments","getDocument","getDocumentSnapshot","getOperationProgress","uploadDocument","stageAttachments","submitApplication","fillApplication"]);
/** Mutations run only through executeCommand, which holds the approval they need. */
const refuseUnapproved = async () => { throw new Error("Writes must go through an approved command"); };
export const methods: Record<string, (...args: any[]) => Promise<unknown>> = {
  getSubmissionStatus,
  verifyWriteApproval,
  setDefaultDocuments: refuseUnapproved,
  // The dashboard uses this route for unattended reconciliation.
  localApplicationRead: (method,args) => localRead(method,args,false),
  submissionCommand: (binding, method, args) => {
    if (!applicationMethods.has(method) || !Array.isArray(args)) throw new Error("Unsupported submission method");
    if (MUTATING_METHODS.has(method)) return refuseUnapproved();
    return callSubmission(method,args,Date.now()+180_000,binding);
  },
  bootstrap: async () => (await browserResearch.bootstrap()) ?? null,
  health: async () => {
    const state = await browserResearch.health();
    if (state.authenticated) await clearSignInEpisode();
    const tabs = await browserDiagnostics().catch(()=>[]);
    return { ...state, ...(EXTENSION_BUILD!=="development" ? {extensionBuild:EXTENSION_BUILD} : {}), ...(tabs.length ? {browserDiagnostics:tabs} : {}), ...(lastTabInspection() ? {lastTabInspection:lastTabInspection()} : {}), ...(reads.applicationInventoryEvidence ? { applicationInventoryEvidence: reads.applicationInventoryEvidence } : {}) };
  },
  searchJobs: (...args) => browserResearch.searchJobs(...args),
  getJob: (id, options) => browserResearch.getJob(id, options),
  getSearchMetadata: () => browserResearch.getSearchMetadata(),
  getAccountOverview: options => browserResearch.getAccountOverview(options),
  getDocumentMetadata: () => browserResearch.getDocumentMetadata(),
  getEmployerReport: id => browserResearch.getEmployerReport(id),
  ...Object.fromEntries([...applicationMethods].map(method => [method, MUTATING_METHODS.has(method) ? refuseUnapproved : (...args:unknown[]) => callSubmission(method,args,Date.now()+180_000)])),
  // Preparation reads use the signed-in profile. Pinned submissionCommand
  // requests bypass these handlers and validate in the server's own context.
  ...Object.fromEntries(Object.keys(localReads).map(method => [method, (...args:unknown[]) => localRead(method,args)])),
  discoveryPolicyGet: () => policyGet(),
  discoveryPolicySave: policy => policySave(policy),
  discoveriesList: () => discoveriesList(),
  discoveryStatus: () => discoveryStatus(),
};

export async function daily(force=false):Promise<unknown>{
  if(!force)return;
  return runDiscovery();
}

/** Carry the broker deadline through each irreversible browser step. */
export async function executeCommand(method: string, args: any[], deadline: number,onProgress?:(progress:ApplicationProgress)=>void,approval?:string): Promise<unknown> {
  const run = methods[method];
  if (!run) throw new Error("Unsupported extension method");
  if (deadline <= Date.now()) throw new Error("Extension command expired");
  const target = effectiveCommand(method, args);
  if (MUTATING_METHODS.has(target.method)) await authorizeWrite(target.method, target.args, approval);
  if (method === "verifyWriteApproval") return verifyWriteApproval(args[0],args[1],args[2]);
  if (method === "localApplicationRead") return localRead(args[0],args[1],false);
  if (method === "submissionCommand") {
    if (!applicationMethods.has(args[1]) || !Array.isArray(args[2])) throw new Error("Unsupported submission method");
    return onProgress?callSubmission(args[1], args[2], deadline, args[0],onProgress):callSubmission(args[1], args[2], deadline, args[0]);
  }
  if (Object.hasOwn(localReads,method)) return localRead(method,args);
  if (applicationMethods.has(method)) return onProgress?callSubmission(method,args,deadline,undefined,onProgress):callSubmission(method,args,deadline);
  return withSignInRecovery(method, () => run(...args));
}
