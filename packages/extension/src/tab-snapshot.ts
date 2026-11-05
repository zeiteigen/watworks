/** Injected in a WaterlooWorks tab. Reads DOM only; never validates, clicks or submits. */
export function tabSnapshot(includeHtml: boolean) {
  if (location.origin !== "https://waterlooworks.uwaterloo.ca") throw new Error("Tab is not on WaterlooWorks");
  const visible = (e: Element) => !!e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
  const controls = [...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement>("input,select,textarea,button")];
  const documentValue = (e: Element) => e.matches('input[type="radio"][data-dt-id],select[name^="selectExisting_"]');
  const safeValue = (e: HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement) =>
    (documentValue(e) && /^\d{1,32}$/.test(e.value)) || (e.name==="applyOption" && ["customPkg","existingPkg","defaultPkg"].includes(e.value)) ? e.value : e.value ? "[redacted]" : "";
  const fields = controls.slice(0,400).map(e=>({tag:e.tagName.toLowerCase(),id:e.id,name:e.name,type:e.type,
    value:safeValue(e),valuePresent:!!e.value,checked:e instanceof HTMLInputElement?e.checked:null,
    disabled:e.matches(":disabled"),visible:visible(e),required:"required" in e?e.required:false,
    valid:e.willValidate?e.validity.valid:null,
    validity:e.willValidate?{valueMissing:e.validity.valueMissing,typeMismatch:e.validity.typeMismatch,patternMismatch:e.validity.patternMismatch,customError:e.validity.customError}:null,
    label:e instanceof HTMLButtonElement?(e.textContent??"").replace(/\s+/g," ").trim().slice(0,150):null,
  }));
  const wizardButtons = [...document.querySelectorAll<HTMLButtonElement>('.js--ui-wizard-next-btn')].map(e=>({
    tag:e.tagName.toLowerCase(),id:e.id,label:(e.textContent||e.value||"").replace(/\s+/g," ").trim(),
    disabled:e.matches(":disabled"),ariaDisabled:e.getAttribute("aria-disabled"),visible:visible(e),classes:e.className,
  }));
  let html: string | undefined;
  let htmlTruncated = false;
  if (includeHtml) {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    // Keep live control state in the clone rather than the original server defaults.
    const copied = [...clone.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement>("input,select,textarea,button")];
    controls.forEach((e,i)=>{
      const target=copied[i];if(!target)return;
      if(e instanceof HTMLInputElement) { target.setAttribute("value",safeValue(e));e.checked?target.setAttribute("checked",""):target.removeAttribute("checked"); }
      if(e instanceof HTMLTextAreaElement)target.textContent=safeValue(e);
      if(e instanceof HTMLButtonElement)target.setAttribute("value",safeValue(e));
      if(e instanceof HTMLSelectElement) [...target.querySelectorAll("option")].forEach((o,index)=>{const live=e.options[index];if(live?.selected)o.setAttribute("selected","");else o.removeAttribute("selected");});
    });
    for(const node of clone.querySelectorAll("script,meta,iframe,object,embed,base,link,style,template"))node.remove();
    const comments=document.createTreeWalker(clone,128);const remove:Node[]=[];
    while(comments.nextNode())remove.push(comments.currentNode);
    for(const comment of remove)comment.parentNode?.removeChild(comment);
    const allowed=new Set(["id","class","name","type","value","checked","selected","disabled","required","role","tabindex","rows","cols","multiple","minlength","maxlength","min","max","step","placeholder","aria-label","aria-disabled","aria-hidden","data-dt-id","data-status","data-step"]);
    for(const e of [clone,...clone.querySelectorAll("*")]) {
      for(const attr of [...e.attributes]) {
        const name=attr.name.toLowerCase();
        if(!allowed.has(name))e.removeAttribute(attr.name);
      }
      if(e.tagName==="OPTION" && !e.closest('select[name^="selectExisting_"]')) e.setAttribute("value", "[redacted]");
      if(e.tagName==="OPTION" && e.closest('select[name^="selectExisting_"]') && !/^\d{1,32}$/.test(e.getAttribute("value")??""))e.setAttribute("value", "");
    }
    const serialized=clone.outerHTML;
    htmlTruncated=serialized.length>300_000;html=serialized.slice(0,300_000);
  }
  const postingId=document.querySelector<HTMLInputElement>('#applyForm input[name="postingId"]')?.value;
  return {capturedAt:new Date().toISOString(),url:location.origin+location.pathname,title:document.title,
    postingId:postingId&&/^\d{1,32}$/.test(postingId)?postingId:null,readyState:document.readyState,
    fields,fieldsTruncated:controls.length>400,wizardButtons,
    selectedDocuments:controls.filter(e=>e instanceof HTMLInputElement&&e.matches('input[type="radio"][data-dt-id]:checked')).map(e=>({requirementId:e.name,id:e.value,disabled:e.matches(":disabled")})),
    ...(includeHtml?{html,htmlTruncated}:{}),
  };
}
