import { discoveryRequest, hasSubmissionAccess } from "./submission-client.js";

let active:Promise<void>|undefined;
/** Poll metadata only. Share a session solely when the server's daily scan is due. */
export function refreshDueDiscovery():Promise<void>{
  if(active)return active;
  active=(async()=>{
    if (!await hasSubmissionAccess()) return;
    const state=await discoveryRequest("") as {due?:boolean};
    if(state.due)await discoveryRequest("/scan",{});
  })().finally(()=>{active=undefined;});
  return active;
}
