import { EXTENSION_BUILD } from "./build-info.js";
import type { tabSnapshot } from "./tab-snapshot.js";
import type { diagnosticTabs } from "./tab-inspection.js";

const element=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const tabs=element<HTMLSelectElement>("tabs"), state=element<HTMLTextAreaElement>("state"), html=element<HTMLTextAreaElement>("html");
const feedback=element<HTMLParagraphElement>("diagnostic-status"), capture=element<HTMLButtonElement>("inspect");
element("build").textContent="Extension build: "+EXTENSION_BUILD;
async function request<T>(message:Record<string,unknown>):Promise<T>{
  const result=await chrome.runtime.sendMessage(message);
  if(!result?.ok)throw new Error(result?.error??"Inspection failed");return result.value;
}
async function refresh(){
  try {
    const previous=tabs.value;
    const items=await request<Awaited<ReturnType<typeof diagnosticTabs>>>({type:"debugListTabs"});
    tabs.replaceChildren(...items.map(tab=>{const option=document.createElement("option");option.value=String(tab.id);option.textContent=`${tab.title} · ${tab.url} · tab ${tab.id}`;return option;}));
    if(items.some(tab=>String(tab.id)===previous))tabs.value=previous;
    capture.disabled=!items.length;feedback.textContent=items.length?`${items.length} WaterlooWorks tabs. Choose one and capture its current state.`:"No WaterlooWorks tabs are open.";
  }catch(error){feedback.textContent=String(error);}
}
async function inspect(){
  capture.disabled=true;feedback.textContent="Reading tab…";
  try{
    const report=await request<ReturnType<typeof tabSnapshot>>({type:"debugInspectTab",tabId:Number(tabs.value),includeHtml:element<HTMLInputElement>("include-html").checked});
    const {html:markup,...details}=report;
    state.value=JSON.stringify({extensionBuild:EXTENSION_BUILD,tabId:Number(tabs.value),...details},null,2);html.value=markup??"";
    element<HTMLButtonElement>("copy-state").disabled=false;element<HTMLButtonElement>("copy-html").disabled=!markup;
    feedback.textContent=`Captured ${report.capturedAt}. ${report.wizardButtons.filter(b=>b.visible).map(b=>`${b.label}: ${b.disabled?"disabled":"enabled"}`).join(" · ")||"No visible wizard button"}${report.htmlTruncated?". HTML truncated at 300,000 characters":""}`;
  }catch(error){feedback.textContent=String(error);}finally{capture.disabled=!tabs.options.length;}
}
element("refresh").addEventListener("click",()=>void refresh());
capture.addEventListener("click",()=>void inspect());
for(const [button,target] of [["copy-state",state],["copy-html",html]] as const)element(button).addEventListener("click",()=>{void navigator.clipboard.writeText(target.value).then(()=>{feedback.textContent="Copied.";},()=>{feedback.textContent="Copy failed. Select and copy the text below.";});});
void refresh();
