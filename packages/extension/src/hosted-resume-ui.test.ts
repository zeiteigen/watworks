import {expect,test} from 'bun:test';
import {withDom as withTestDom} from './hosted-test-dom.js';
import {customResumeToggle,renderResumeChanges,resumeStep,type HostedCustomResume} from './hosted-resume-ui.js';
import type {HostedJob} from './hosted-queue.js';

const base={heading:{name:'Ada',contacts:[]},sections:[{kind:'experience' as const,title:'Experience',entries:[{role:'Developer',organization:'Acme',bullets:['Built fast tools','Wrote documentation']}]}]};
const custom:HostedCustomResume={requested:true,draftId:'00000000-0000-4000-8000-000000000001',base,accepted:['c0','c1'],pdf:{name:'r.pdf',sha256:'b'.repeat(64)},changes:[
  {id:'c0',kind:'rewrite',target:'s0.e0.b0',before:'Built fast tools',after:'Built fast <b>internal</b> tools',reason:'Posting <i>asks</i>'},
  {id:'c1',kind:'remove',target:'s0.e0.b1',before:'Wrote documentation'},
]};
const withDom=(run:(document:Document)=>void)=>withTestDom('<main><article></article></main>',run);

test('word review toggles single edits and renders model text only as text',()=>withDom(document=>{
  const kept=new Set(['c0.w0','c1']);let changes=0;
  const list=renderResumeChanges(custom,'word',kept,()=>changes++);
  expect(list.querySelector('b')).toBeNull();expect(list.textContent).toContain('<b>internal</b>');expect(list.textContent).toContain('Posting <i>asks</i>');
  const hunk=list.querySelector('button.word-hunk') as unknown as HTMLButtonElement;
  expect(hunk.getAttribute('aria-pressed')).toBe('true');expect(hunk.textContent).toBe('<b>internal</b> ');
  hunk.click();expect(kept.has('c0.w0')).toBe(false);expect(changes).toBe(1);
  const removal=list.querySelectorAll('input[type=checkbox]')[1] as unknown as HTMLInputElement;
  removal.checked=false;removal.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event('change'));expect(kept.has('c1')).toBe(false);
  // Line by line, every change still has its own keep box, but edits are not split.
  const lines=renderResumeChanges(custom,'line',kept,()=>{});
  expect(lines.querySelectorAll('input[type=checkbox]').length).toBe(2);expect(lines.querySelector('button')).toBeNull();
}));

test('the tailored resume opens on the PDF, rebuilds changed choices first, and approves only the current hash',()=>withDom(document=>{
  const started:Array<()=>Promise<void>>=[];
  const ctx={hooks:{refresh:()=>{},report:()=>{},progress:()=>{}},resumes:[],reviewMode:'line' as const,act:(write:()=>Promise<void>)=>{started.push(write);}};
  const job:HostedJob={jobId:'7',status:'resume_review',resumeId:'r',form:{requirements:[]},customResume:structuredClone(custom)};
  const step=resumeStep(job,ctx);
  // The PDF comes first; the change list only appears on request or when the PDF cannot be marked.
  expect(step.body.querySelector('.pdf-review')).not.toBeNull();
  expect(step.body.querySelector<HTMLElement>('.resume-review-list')!.hidden).toBe(true);
  expect(step.body.querySelector('.review-count')!.textContent).toBe('2 of 2 changes kept');
  expect(step.primary!.textContent).toBe('Approve resume and upload');
  expect(step.primary!.hasAttribute('data-write')).toBe(true);
  step.primary!.click();expect(started.length).toBe(1);
  step.menu!.find(item=>item.textContent==='Show the changes as a list')!.click();
  const box=step.body.querySelectorAll('.resume-review-list input[type=checkbox]')[1] as unknown as HTMLInputElement;
  box.checked=false;box.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event('change'));
  expect(step.body.querySelector('.review-count')!.textContent).toBe('1 of 2 changes kept · not in the PDF yet');
  expect(step.primary!.textContent).toBe('Apply my choices');
  expect(step.primary!.hasAttribute('data-write')).toBe(false);
}));

test('only jobs before any generated letter or approval can switch to a tailored resume',()=>withDom(()=>{
  const hooks={refresh:()=>{},report:()=>{},progress:()=>{}};
  const job:HostedJob={jobId:'8',status:'review',resumeId:'r',form:{requirements:[]}};
  expect(customResumeToggle(job,hooks,false)!.textContent).toBe('Tailor it for this job');
  expect(customResumeToggle({...job,status:'cover_letter_review',coverLetter:{sha256:'c'.repeat(64),name:'l.pdf',source:'generated'}},hooks,false)).toBeNull();
  expect(customResumeToggle({...job,status:'uploading'},hooks,false)).toBeNull();
}));
