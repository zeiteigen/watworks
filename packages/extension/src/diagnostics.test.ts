import {expect,test} from "bun:test";
import {parseHTML} from "linkedom";
import {runInNewContext} from "node:vm";

test("diagnostics UI lists tabs and displays an inert state/HTML capture",async()=>{
 const page=await Bun.file(new URL("./diagnostics.html",import.meta.url)).text();
 const {document,window}=parseHTML(page);
 const calls:Record<string,unknown>[]=[];
 const built=await Bun.build({entrypoints:[`${import.meta.dir}/diagnostics.ts`],target:"browser",format:"esm"});
 expect(built.success).toBe(true);
 runInNewContext(await built.outputs[0]!.text(),{document,console,navigator:{clipboard:{writeText:async()=>{}}},chrome:{runtime:{sendMessage:async(message:Record<string,unknown>)=>{
   calls.push(message);
   return {ok:true,value:message.type==="debugListTabs"?[{id:7,title:"Application",url:"https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm"}]:{capturedAt:"2026-11-03T02:00:00Z",wizardButtons:[{label:"Submit",visible:true,disabled:true}],html:'<form id="applyForm"><button disabled>Submit</button></form>',htmlTruncated:false}};
 }}}});
 const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};await settle();
 expect(document.querySelectorAll("#tabs option")).toHaveLength(1);
 // Linkedom does not select the first option automatically as Chrome does.
 document.querySelector("#tabs option")!.setAttribute("selected","");
 document.getElementById("inspect")!.dispatchEvent(new window.Event("click"));await settle();
 expect(calls.at(-1)).toMatchObject({type:"debugInspectTab",tabId:7});
 expect(document.getElementById("diagnostic-status")!.textContent).toContain("Submit: disabled");
 expect(document.querySelector<HTMLTextAreaElement>("#state")!.value).toContain('"extensionBuild": "development"');
 expect(document.querySelector<HTMLTextAreaElement>("#html")!.value).toContain("<form");
 expect(document.querySelector("#html form")).toBeNull();
});
