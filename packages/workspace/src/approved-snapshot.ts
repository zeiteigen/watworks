import { randomUUID, createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { Workspace } from "./store.js";
import { writeAtomic } from "./store.js";
import { attachmentPath } from "./plans.js";
import type { JobKey } from "./paths.js";
import type { ApplicationPlan } from "./schemas.js";

/** Capture bytes once: approval and the queued operation reference the same content. */
export async function captureApplication(workspace: Workspace, key: JobKey, input: ApplicationPlan) {
  const plan=structuredClone(input);
  const resume=await readFile(workspace.paths.resume(plan.resumeVariant).pdf);
  const attachments=await Promise.all(plan.attachments.map(async attachment=>({
    requirementId:attachment.requirementId,
    filename:basename(attachmentPath(workspace,key,attachment)),
    bytes:await readFile(attachmentPath(workspace,key,attachment)),
  })));
  const digest=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
  const files:Record<string,string>={resume:digest(resume)};
  for(const attachment of attachments)files[attachment.requirementId]=digest(attachment.bytes);
  return {plan,resume,attachments,hash:digest(JSON.stringify({plan,files}))};
}

export interface ApprovedSnapshot { plan: ApplicationPlan; resumePath: string; dispose(): Promise<void> }
export async function freezeApplication(workspace: Workspace, captured: Awaited<ReturnType<typeof captureApplication>>): Promise<ApprovedSnapshot> {
  const paths=workspace.paths.approvalSnapshot(randomUUID(),captured.attachments.map(a=>a.filename));
  try {
    await writeAtomic(paths.resume,captured.resume,0o600);
    for(let i=0;i<captured.attachments.length;i++)await writeAtomic(paths.attachments[i]!,captured.attachments[i]!.bytes,0o600);
    const plan=structuredClone(captured.plan);
    plan.attachments=captured.attachments.map((attachment,i)=>({kind:"file",requirementId:attachment.requirementId,path:paths.attachments[i]!}));
    return {plan,resumePath:paths.resume,dispose:()=>rm(paths.dir,{recursive:true,force:true})};
  } catch(error) { await rm(paths.dir,{recursive:true,force:true});throw error; }
}
