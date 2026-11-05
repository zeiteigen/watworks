import { discoveryRequest } from "./submission-client.js";
import { policyGet } from "./discovery-policy.js";
export type { DiscoveryResult } from "../../shared/src/discovery-result.js";
export async function discoveriesList():Promise<import("../../shared/src/discovery-result.js").DiscoveryResult[]>{
  await policyGet();
  return (await discoveryRequest("") as {discoveries:import("../../shared/src/discovery-result.js").DiscoveryResult[]}).discoveries;
}
export async function discoveryStatus():Promise<unknown>{await policyGet();return (await discoveryRequest("") as {status:unknown}).status;}
export async function runDiscovery():Promise<unknown>{await policyGet();return discoveryRequest("/scan",{});}
