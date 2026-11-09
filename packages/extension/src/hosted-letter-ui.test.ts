import {expect,test} from 'bun:test';
import {parseHTML} from 'linkedom';
import {appendHostedLetter} from './hosted-letter-ui.js';

test('letter review offers preview, replacement and approval while discovery does not draft',()=>{
  const dom=parseHTML('<main><article></article></main>'),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.document});
  try{
    const card=dom.document.querySelector('article') as unknown as HTMLElement;
    const job={jobId:'1',status:'review',form:{requirements:[{id:'letter',typeId:'66',role:'attachment',label:'Cover letter'}]}};
    let approved=0;
    appendHostedLetter(card,job,()=>{},()=>{},async()=>{approved++;});
    expect(approved).toBe(0);expect(card.textContent).toContain('only after you approve');expect(card.textContent).toContain('Upload my PDF');
    card.replaceChildren();appendHostedLetter(card,{...job,status:'cover_letter_review',coverLetter:{sha256:'a'.repeat(64),name:'letter.pdf',texKey:'source'}},()=>{},()=>{},async hash=>{expect(hash).toBe('a'.repeat(64));approved++;});
    expect(card.textContent).toContain('Preview cover letter PDF');expect(card.textContent).toContain('Download LaTeX source');expect(card.textContent).toContain('Approve cover letter and application uploads');
    expect(approved).toBe(0);
    card.replaceChildren();appendHostedLetter(card,{...job,status:'drafting_cover_letter'},()=>{},()=>{},async()=>{approved++;});
    expect(card.querySelector('form')).toBeNull();expect(card.querySelector('button')).toBeNull();expect(approved).toBe(0);
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});

test('a picked cover letter survives a queue re-render, and a finished upload starts clean',()=>{
  const dom=parseHTML('<main><article></article></main>'),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.document});
  try{
    const card=dom.document.querySelector('article') as unknown as HTMLElement;
    const job={jobId:'keep',status:'review',form:{requirements:[{id:'letter',typeId:'66',role:'attachment',label:'Cover letter'}]}};
    const render=(status=job.status)=>{card.replaceChildren();appendHostedLetter(card,{...job,status},()=>{},()=>{},async()=>{});return card.querySelector('input[type=file]');};
    const input=render();
    expect(input).not.toBeNull();expect(render()).toBe(input);
    (card.querySelector('button[type=submit]') as unknown as HTMLButtonElement).disabled=true;
    render();expect((card.querySelector('button[type=submit]') as unknown as HTMLButtonElement).disabled).toBe(false);
    expect(render('drafting_cover_letter')).toBeNull();
    expect(render()).not.toBe(input);
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});

test('a failed draft shows the reason saved on the job',()=>{
  const dom=parseHTML('<main><article></article></main>'),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.document});
  try{
    const card=dom.document.querySelector('article') as unknown as HTMLElement;
    appendHostedLetter(card,{jobId:'failed',status:'cover_letter_failed',coverLetterError:'Your LaTeX template could not be compiled.',form:{requirements:[{id:'letter',typeId:'66',role:'attachment',label:'Cover letter'}]}},()=>{},()=>{},async()=>{});
    expect(card.textContent).toContain('Your LaTeX template could not be compiled.');
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});
