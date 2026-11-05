import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import { tabSnapshot } from "./tab-snapshot.js";
let lastInspection: ({tabId:number}&ReturnType<typeof tabSnapshot>) | undefined;
export const lastTabInspection=()=>lastInspection;

export async function diagnosticTabs() {
  const tabs=await chrome.tabs.query({url:WATERLOOWORKS_ORIGIN+"/*"});
  return tabs.filter(tab=>tab.id!==undefined).slice(0,100).map(tab=>({id:tab.id!,title:tab.title??"WaterlooWorks",url:tab.url?new URL(tab.url).origin+new URL(tab.url).pathname:null}));
}

export async function inspectTab(tabId: unknown, includeHtml: unknown) {
  if(typeof tabId!=="number"||!Number.isSafeInteger(tabId)||tabId<0)throw new Error("Invalid tab ID");
  const tab=await chrome.tabs.get(tabId);
  if(!tab.url||new URL(tab.url).origin!==WATERLOOWORKS_ORIGIN)throw new Error("Choose a WaterlooWorks tab");
  const results=await chrome.scripting.executeScript({target:{tabId},func:tabSnapshot,args:[includeHtml===true]});
  if(!results[0]?.result)throw new Error("The tab could not be inspected; it may have closed or navigated");
  lastInspection={tabId,...results[0].result};
  return results[0].result;
}
