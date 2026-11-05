import { WATERLOOWORKS_JOBS_URL, WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import type { BrowserApplicationReads } from "./application-reads.js";
interface ManualAction {kind:"inspect"|"openWizard";jobId?:string;entry?:Record<string,string>}
/** Manual navigation only: no uploads, answers, wizard advancement, or submission. */
function manualEntry(action:ManualAction) {
  try {
    if(location.origin!=="https://waterlooworks.uwaterloo.ca")throw new Error("Application tab left WaterlooWorks");
    if(action.kind==="openWizard") {
      const entry=action.entry;
      if(!entry||entry.postingId!==action.jobId||!entry.action||entry.action.length>1000||Object.keys(entry).some(key=>key!=="postingId"&&key!=="action"))throw new Error("Application entry form changed");
      const form=document.createElement("form");form.method="POST";form.action="/myAccount/co-op/full/jobs.htm";
      for(const [name,value] of Object.entries(entry)){const input=document.createElement("input");input.type="hidden";input.name=name;input.value=value;form.append(input);}
      document.body.append(form);HTMLFormElement.prototype.submit.call(form);
    }
    return {failure:null,postingId:document.querySelector<HTMLInputElement>('#applyForm input[name="postingId"]')?.value??null};
  } catch(error){return {failure:{message:error instanceof Error?error.message:"Application page unavailable"},postingId:null};}
}
async function control(tabId: number, action: ManualAction) {
  const result = (await chrome.scripting.executeScript({target:{tabId},func:manualEntry,args:[action]}))[0]?.result;
  if (!result || result.failure) throw new Error(result?.failure?.message ?? "Application page is unavailable");
  return result;
}

/** Opens the validated application entry, leaving every form control to the user. */
export async function openApplicationForm(jobId: unknown, reads: Pick<BrowserApplicationReads, "getApplicationEntry">) {
  if (typeof jobId !== "string" || !/^\d{1,16}$/.test(jobId) || !Number.isSafeInteger(Number(jobId)) || Number(jobId) <= 0) {
    throw new Error("Invalid WaterlooWorks posting ID");
  }
  const entry = await reads.getApplicationEntry(jobId);
  const tab = await chrome.tabs.create({ url: WATERLOOWORKS_JOBS_URL, active: true });
  if (tab.id === undefined) throw new Error("Could not open WaterlooWorks");
  const deadline = Date.now() + 30_000;
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  while ((await chrome.tabs.get(tab.id)).status !== "complete") {
    if (Date.now() >= deadline) throw new Error("WaterlooWorks did not finish loading");
    await pause();
  }
  if (!(await chrome.tabs.get(tab.id)).url?.startsWith(WATERLOOWORKS_ORIGIN + "/")) {
    throw new Error("Sign in to WaterlooWorks before opening an application form");
  }
  let navigationError: unknown;
  try { await control(tab.id, { kind: "openWizard", jobId, entry: entry.fields }); }
  catch (error) { navigationError = error; } // Navigation can unload the injection frame.
  while (Date.now() < deadline) {
    try {
      if ((await control(tab.id, { kind: "inspect" })).postingId === jobId) return { tabId: tab.id, jobId };
    } catch { /* The wizard may still be navigating. */ }
    await pause();
  }
  throw navigationError ?? new Error("WaterlooWorks did not open the requested application form; inspect the opened tab");
}
