import { DiscoveryPolicySchema, type DiscoveryPolicy } from "../../shared/src/discovery-policy.js";
import { discoveryRequest, prepareSubmissionSession } from "./submission-client.js";
export { DiscoveryPolicySchema, type DiscoveryPolicy } from "../../shared/src/discovery-policy.js";
/** Initialize once from the existing local policy; the server never overwrites an established policy. */
export async function policyGet():Promise<DiscoveryPolicy>{
  const stored=await chrome.storage.local.get("discovery:policy");
  const legacy=DiscoveryPolicySchema.parse(stored["discovery:policy"]??{});
  try{return DiscoveryPolicySchema.parse(await discoveryRequest("/policy",{policy:legacy,initialize:true}));}
  catch{return legacy;}
}
export async function policySave(input:unknown):Promise<DiscoveryPolicy>{
  const policy=DiscoveryPolicySchema.parse(input);
  await prepareSubmissionSession();
  return DiscoveryPolicySchema.parse(await discoveryRequest("/policy",{policy}));
}
