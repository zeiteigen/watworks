import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import { tabSnapshot } from "./tab-snapshot.js";

/** Inspect existing tabs without clicking, navigating, or changing forms. */
export async function browserDiagnostics() {
  const tabs=(await chrome.tabs.query({url:WATERLOOWORKS_ORIGIN+"/*"})).filter(tab=>tab.id!==undefined).slice(-8);
  return Promise.all(tabs.map(async tab=>{
    try {
      const result=await chrome.scripting.executeScript({target:{tabId:tab.id!},func:tabSnapshot,args:[false]});
      return {tabId:tab.id!,...result[0]?.result};
    }catch{return {tabId:tab.id!,unavailable:true};}
  }));
}
