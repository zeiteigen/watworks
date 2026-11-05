import {afterEach,expect,test} from "bun:test";
import {parseHTML} from "linkedom";
import {runInNewContext} from "node:vm";
import {tabSnapshot} from "./tab-snapshot.js";
import {inspectTab} from "./tab-inspection.js";

function fixture(){
 const {document,window}=parseHTML(`<html><head><title>Application</title><script>const token='SCRIPT_SECRET'</script><meta content="META_SECRET"></head><body>
 <!-- COMMENT_SECRET --><template><script>TEMPLATE_SECRET</script></template>
 <form id="applyForm" action="/submit?token=URL_SECRET"><input type="hidden" name="postingId" value="123">
 <input type="hidden" name="action" value="ACTION_SECRET"><input type="password" value="PASSWORD_SECRET">
 <input name="67" type="radio" data-dt-id="67" value="900" checked><textarea name="answer">ANSWER_SECRET</textarea>
 <button class="js--ui-wizard-next-btn" disabled onclick="SECRET_HANDLER()" value="BUTTON_SECRET">Submit</button>
 </form></body></html>`);
 window.Element.prototype.getClientRects=function(this:Element){return this.hasAttribute("hidden")?[]:[{}];} as unknown as typeof window.Element.prototype.getClientRects;
 const radio=document.querySelector<HTMLInputElement>('input[name="67"]')!;
 Object.defineProperty(radio,"checked",{value:true});
 const run=(includeHtml:boolean,origin="https://waterlooworks.uwaterloo.ca")=>runInNewContext(`(${tabSnapshot.toString()})(includeHtml)`,{
 document,includeHtml,location:{origin,pathname:"/myAccount/co-op/full/jobs.htm"},getComputedStyle:()=>({visibility:"visible"}),
 HTMLInputElement:window.HTMLInputElement,HTMLSelectElement:window.HTMLSelectElement,HTMLTextAreaElement:window.HTMLTextAreaElement,HTMLButtonElement:window.HTMLButtonElement,
 }) as ReturnType<typeof tabSnapshot>;
 return {document,run};
}

test("snapshot reports Submit availability and live document state without leaking private values",()=>{
 const {run}=fixture();const report=run(true);
 expect(report.postingId).toBe("123");
 expect(report.wizardButtons).toEqual([expect.objectContaining({label:"Submit",disabled:true,visible:true})]);
 expect(report.selectedDocuments).toEqual([{requirementId:"67",id:"900",disabled:false}]);
 expect(report.html).toContain('value="900"');
 expect(report.html).not.toContain("SECRET");
 expect(report.html).not.toContain("<script");
 expect(JSON.stringify(report)).not.toContain("SECRET");
});

test("HTML is optional and a navigation away from WaterlooWorks is refused",()=>{
 const {run}=fixture();expect(run(false).html).toBeUndefined();
 expect(()=>run(true,"https://login.example.com")).toThrow("not on WaterlooWorks");
});

const original=globalThis.chrome;
afterEach(()=>{globalThis.chrome=original;});
test("inspection validates the requested tab and never injects into a foreign origin",async()=>{
 let scripts=0;
 globalThis.chrome={tabs:{get:async()=>({url:"https://example.com/"})},scripting:{executeScript:async()=>{scripts++;return [];}}} as unknown as typeof chrome;
 await expect(inspectTab(-1,true)).rejects.toThrow("Invalid tab");
 await expect(inspectTab(1,true)).rejects.toThrow("Choose a WaterlooWorks tab");
 expect(scripts).toBe(0);
});
