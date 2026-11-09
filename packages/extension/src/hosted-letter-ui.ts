import { hostedRequest } from './hosted-client.js';
import type { HostedJob } from './hosted-queue.js';
export function hasHostedCoverSlot(job:HostedJob):boolean{
  const requirements=job.form?.requirements;
  return Array.isArray(requirements)&&requirements.some(slot=>slot.role==='attachment'&&(slot.typeId==='66'||/^cover\s*letter$/i.test(slot.label??'')));
}
export function hostedPreparationMessage(status?:string,detail?:string):string{
  if(status==='resume_review')return 'Custom resume ready. Review its changes and PDF, then approve it.';
  if(status==='resume_failed')return detail||'The custom resume could not be drafted. Request a new one or send the base resume.';
  if(status==='cover_letter_review')return 'Cover letter ready. Review its PDF or upload your own, then approve it.';
  if(status==='confirm_required')return 'Application prepared. Review the processed documents in Ready to submit before confirming.';
  if(status==='cover_letter_failed')return detail||'The cover letter could not be drafted. Upload your own PDF or request a new draft.';
  return 'The outcome needs checking. See Needs review before taking another action.';
}
/** Kept across re-renders: rebuilding the input would discard a file the user has already picked. */
const uploadForms=new Map<string,HTMLFormElement>();
function letterUploadForm(job:HostedJob,refresh:()=>void,report:(value:string)=>void):HTMLFormElement{
  const existing=uploadForms.get(job.jobId);
  if(existing){const submit=existing.querySelector<HTMLButtonElement>('button[type=submit]')!;submit.disabled=existing.dataset.uploading==='true';return existing;}
  const form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('input'),upload=document.createElement('button');
  form.className='resume-upload';label.textContent='Use your own cover letter';input.type='file';input.accept='application/pdf,.pdf';input.required=true;label.appendChild(input);upload.type='submit';upload.dataset.write='';upload.textContent='Upload my PDF';form.append(label,upload);
  form.addEventListener('submit',async event=>{event.preventDefault();const file=input.files?.[0];if(!file)return;
    if(file.size>=5_000_000){report('Choose a PDF smaller than 5 MB.');return;}upload.disabled=true;form.dataset.uploading='true';
    try{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
      await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/cover-letter`,{method:'POST',body:JSON.stringify({name:file.name,base64:btoa(binary)})});uploadForms.delete(job.jobId);report('Cover letter uploaded. Preview it, then approve it.');await refresh();
    }catch(error){report(error instanceof Error?error.message:String(error));upload.disabled=false;}
    finally{delete form.dataset.uploading;}
  });
  uploadForms.set(job.jobId,form);return form;
}
export function appendHostedLetter(card:HTMLElement,job:HostedJob,refresh:()=>void,report:(value:string)=>void,approve:(hash?:string)=>Promise<void>):void{
  if(!hasHostedCoverSlot(job)&&!job.coverLetter)return;
  const section=document.createElement('section');section.className='job-detail';
  const heading=document.createElement('h4');heading.textContent='Cover letter';section.appendChild(heading);
  const note=document.createElement('p');note.className='meta';
  note.textContent=job.status==='cover_letter_failed'&&job.coverLetterError?job.coverLetterError:job.status==='drafting_cover_letter'?'Drafting and typesetting your letter with LaTeX…':job.coverLetter?'Review the PDF before approving it. You can replace it with your own PDF before uploads begin.':'A letter is drafted only after you approve this application. You can also supply your own PDF.';
  section.appendChild(note);
  const preview=(label:string,query='')=>{
    const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=label;
    button.addEventListener('click',async()=>{button.disabled=true;try{
      const blob=await hostedRequest<Blob>(`/jobs/${encodeURIComponent(job.jobId)}/cover-letter${query}`);
      const url=URL.createObjectURL(blob);if(query==='?tex=1'){
        const link=document.createElement('a');link.href=url;link.download=`cover-letter-${job.jobId}.tex`;link.click();
      }else await chrome.tabs.create({url});setTimeout(()=>URL.revokeObjectURL(url),300000);
    }catch(error){report(error instanceof Error?error.message:String(error));}finally{button.disabled=false;}});section.appendChild(button);
  };
  if(job.coverLetter){preview('Preview cover letter PDF');if(job.coverLetter.texKey)preview('Download LaTeX source','?tex=1');}
  if(job.processedCoverLetter)preview('Preview processed cover letter','?processed=1');
  if(['review','cover_letter_review','cover_letter_failed'].includes(job.status)){
    section.appendChild(letterUploadForm(job,refresh,report));
  }else uploadForms.delete(job.jobId);
  if(job.status==='cover_letter_review'&&job.coverLetter){
    const button=document.createElement('button');button.type='button';button.dataset.write='';button.textContent=job.customResume&&!job.customResume.approved?'Approve cover letter and tailor resume':'Approve cover letter and application uploads';
    button.addEventListener('click',async()=>{button.disabled=true;try{await approve(job.coverLetter!.sha256);}finally{button.disabled=false;}});section.appendChild(button);
  }
  if(job.status==='cover_letter_failed'){
    const button=document.createElement('button');button.type='button';button.dataset.write='';button.textContent='Request a new LaTeX draft';
    button.addEventListener('click',async()=>{button.disabled=true;try{await approve();}finally{button.disabled=false;}});section.appendChild(button);
  }
  card.appendChild(section);
}
