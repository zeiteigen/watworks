import { expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { appendHostedJobActions } from './hosted-job-actions.js';

test('posting details toggle exposes readable posting fields and requirements as safe text', () => {
  const dom = parseHTML('<main><article></article></main>'), previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.document});
  try {
    const card = dom.document.querySelector('article') as unknown as HTMLElement;
    appendHostedJobActions(card, {jobId: '123', status: 'review', posting: {
      title: 'Engineer', organization: 'Employer', description: '<img src=x onerror=alert(1)>\nBuild software',
      qualifications: 'TypeScript', compensation: '$30/hour', location: {city: 'Waterloo'},
      application: {requiredDocuments: ['Resume', 'Cover letter']}, raw: {private: 'raw source'},
    }, form: {requirements: [{label: 'Transcript', required: true}], questions: [{id: 'q', label: 'Eligible?', type: 'boolean', required: true}], externalSteps: ['Employer portal']}}, () => {}, () => {});
    const button = card.querySelector('button') as HTMLButtonElement, detail = card.querySelector('.posting-content') as HTMLElement;
    const dialog = card.querySelector('dialog') as HTMLDialogElement;
    expect(button.textContent).toBe('View in detail'); expect(dialog.hasAttribute('open')).toBe(false);
    button.click(); expect(dialog.hasAttribute('open')).toBe(true); expect(dialog.contains(detail)).toBe(true);
    for (const text of ['Full posting', 'Engineer', 'Build software', 'TypeScript', '$30/hour', 'Waterloo', 'Resume', 'Cover letter', 'Transcript', 'Eligible?', 'Employer portal']) expect(detail.textContent).toContain(text);
    expect(detail.querySelector('img')).toBeNull(); expect(detail.textContent).not.toContain('raw source');
    (dialog.querySelector('.job-dialog-heading button') as HTMLButtonElement).click(); expect(dialog.hasAttribute('open')).toBe(false);
    expect(card.textContent).toContain('Remove from queue');
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('WaterlooWorks buttons only ask the background to navigate, and report its failure', async () => {
  const dom = parseHTML('<main></main>'), previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), original = globalThis.chrome;
  Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.document});
  const messages: unknown[] = [], reports: string[] = [];
  globalThis.chrome = {runtime: {sendMessage: async (message: {type: string}) => { messages.push(message); return message.type === 'openPosting' ? {ok: true} : {ok: false, error: 'Posting already applied'}; }}} as unknown as typeof chrome;
  try {
    const card = dom.document.createElement('article') as unknown as HTMLElement;
    appendHostedJobActions(card, {jobId: '123', status: 'review'}, () => {}, value => reports.push(value));
    const named = (text: string) => [...card.querySelectorAll('button')].find(item => item.textContent === text) as HTMLButtonElement;
    const view = named('View on WaterlooWorks ↗'), apply = named('Open application form ↗');
    expect((card.querySelector('dialog') as HTMLElement).contains(view)).toBe(true);
    expect(apply.closest('.job-actions')).toBeTruthy();
    view.click(); apply.click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(messages).toEqual([{type: 'openPosting', jobId: '123'}, {type: 'openApplicationForm', jobId: '123'}]);
    expect(reports).toEqual(['Posting already applied']); expect(apply.disabled).toBe(false);
  } finally { globalThis.chrome = original; if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('the application form cannot be opened during a write or after a verified submission', () => {
  const dom = parseHTML('<main></main>'), previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.document});
  try {
    for (const [status, expected] of [['review', true], ['confirm_required', true], ['uncertain', true], ['cover_letter_failed', true], ['uploading', false], ['submitting', false], ['drafting_cover_letter', false], ['submitted', false]] as const) {
      const card = dom.document.createElement('article') as unknown as HTMLElement;
      appendHostedJobActions(card, {jobId: '123', status}, () => {}, () => {});
      expect(card.textContent?.includes('Open application form')).toBe(expected);
      expect(card.textContent).toContain('View on WaterlooWorks');
    }
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('removal controls are absent after execution begins or when an operation is present', () => {
  const dom = parseHTML('<main></main>'), previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.document});
  try {
    for (const status of ['uploading', 'submitting', 'confirm_required', 'submitted', 'uncertain', 'dismissed']) {
      const card = dom.document.createElement('article') as unknown as HTMLElement;
      appendHostedJobActions(card, {jobId: '123', status}, () => {}, () => {});
      expect(card.textContent).not.toContain('Remove from queue'); expect(card.textContent).toContain('View in detail');
    }
    const card = dom.document.createElement('article') as unknown as HTMLElement;
    appendHostedJobActions(card, {jobId: '123', status: 'review', operation: {}}, () => {}, () => {});
    expect(card.textContent).not.toContain('Remove from queue');
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});
