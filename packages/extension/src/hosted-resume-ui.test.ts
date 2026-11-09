import {expect,test} from 'bun:test';
import {parseHTML} from 'linkedom';
import {appendCustomResume,renderResumeChanges,type HostedCustomResume} from './hosted-resume-ui.js';
import type {HostedJob} from './hosted-queue.js';

const base={heading:{name:'Ada',contacts:[]},sections:[{kind:'experience' as const,title:'Experience',entries:[{role:'Developer',organization:'Acme',bullets:['Built fast tools','Wrote documentation']}]}]};
const custom:HostedCustomResume={requested:true,draftId:'00000000-0000-4000-8000-000000000001',base,accepted:['c0','c1'],pdf:{name:'r.pdf',sha256:'b'.repeat(64)},changes:[
  {id:'c0',kind:'rewrite',target:'s0.e0.b0',before:'Built fast tools',after:'Built fast <b>internal</b> tools',reason:'Posting <i>asks</i>'},
  {id:'c1',kind:'remove',target:'s0.e0.b1',before:'Wrote documentation'},
]};
function withDom(run:(document:Document)=>void){
  const dom=parseHTML('<main><article></article></main>'),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.document});
  try{run(dom.document as unknown as Document);}finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
}

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

test('custom resume offers the choice before approval and approves only the current PDF hash',()=>withDom(document=>{
  const card=document.querySelector('article') as unknown as HTMLElement;
  const job:HostedJob={jobId:'7',status:'review',resumeId:'r',form:{requirements:[]}};
  appendCustomResume(card,job,'line',()=>{},()=>{},async()=>{},false);
  expect(card.textContent).toContain('Send with custom resume');expect(card.querySelector('[data-write]')).toBeNull();
  card.replaceChildren();
  let approved:string|undefined;
  appendCustomResume(card,{...job,status:'resume_review',customResume:custom},'line',()=>{},()=>{},async hash=>{approved=hash;},false);
  expect(card.textContent).toContain('Preview PDF with changes marked (2/2 kept)');
  const approve=[...card.querySelectorAll('[data-write]')].at(-1) as unknown as HTMLButtonElement;
  expect(approve.textContent).toBe('Approve custom resume and application uploads');
  approve.click();expect(approved).toBe('b'.repeat(64));
  card.replaceChildren();
  appendCustomResume(card,{...job,status:'cover_letter_review',coverLetter:{sha256:'c'.repeat(64),name:'l.pdf',source:'generated'}},'line',()=>{},()=>{},async()=>{},false);
  expect(card.textContent).toBe('');
}));
