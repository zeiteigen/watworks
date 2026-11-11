import { expect, test } from 'bun:test';
import { canOpenApplicationForm, jobMenu, postingDetail } from './hosted-job-actions.js';
import { openOnWaterlooWorks } from './hosted-step.js';
import { withDom } from './hosted-test-dom.js';

const hooks = { refresh: () => {}, report: () => {}, progress: () => {} };
const labels = (items: HTMLButtonElement[]) => items.map(item => item.textContent);

test('posting details expose readable posting fields and requirements as safe text', () => withDom('<main></main>', () => {
  const detail = postingDetail({jobId: '123', status: 'review', posting: {
    title: 'Engineer', organization: 'Employer', description: '<img src=x onerror=alert(1)>\nBuild software',
    qualifications: 'TypeScript', compensation: '$30/hour', location: {city: 'Waterloo'},
    application: {requiredDocuments: ['Resume', 'Cover letter']}, raw: {private: 'raw source'},
  }, form: {requirements: [{label: 'Transcript', required: true}], questions: [{id: 'q', label: 'Eligible?', type: 'boolean', required: true}], externalSteps: ['Employer portal']}});
  for (const text of ['Engineer', 'Build software', 'TypeScript', '$30/hour', 'Waterloo', 'Resume', 'Cover letter', 'Transcript', 'Eligible?', 'Employer portal']) expect(detail.textContent).toContain(text);
  expect(detail.querySelector('img')).toBeNull(); expect(detail.textContent).not.toContain('raw source');
}));

test('WaterlooWorks links only ask the background to navigate, and report its failure', async () => {
  const original = globalThis.chrome, messages: unknown[] = [], reports: string[] = [];
  globalThis.chrome = {runtime: {sendMessage: async (message: {type: string}) => { messages.push(message); return message.type === 'openPosting' ? {ok: true} : {ok: false, error: 'Posting already applied'}; }}} as unknown as typeof chrome;
  try {
    await openOnWaterlooWorks('openPosting', {jobId: '123', status: 'review'}, value => reports.push(value));
    await openOnWaterlooWorks('openApplicationForm', {jobId: '123', status: 'review'}, value => reports.push(value));
    expect(messages).toEqual([{type: 'openPosting', jobId: '123'}, {type: 'openApplicationForm', jobId: '123'}]);
    expect(reports).toEqual(['Posting already applied']);
  } finally { globalThis.chrome = original; }
});

test('the application form cannot be opened during a write or after a verified submission', () => withDom('<main></main>', () => {
  for (const [status, expected] of [['review', true], ['confirm_required', true], ['uncertain', true], ['cover_letter_failed', true], ['uploading', false], ['submitting', false], ['drafting_cover_letter', false], ['submitted', false]] as const) {
    expect(canOpenApplicationForm(status)).toBe(expected);
    const items = labels(jobMenu({jobId: '123', status}, hooks, () => {}, {applicationForm: true}));
    expect(items.includes('Open application form ↗')).toBe(expected);
    expect(items).toContain('View on WaterlooWorks ↗');
  }
}));

test('removal is offered whenever nothing is running, and asks twice once the job is past review', () => withDom('<main></main>', () => {
  for (const status of ['uploading', 'submitting', 'submitted', 'dismissed', 'drafting_cover_letter']) {
    expect(labels(jobMenu({jobId: '123', status}, hooks, () => {}, {applicationForm: true}))).not.toContain('Remove from my list');
  }
  for (const status of ['review', 'confirm_required', 'uncertain', 'cover_letter_review']) {
    expect(labels(jobMenu({jobId: '123', status, operation: {}}, hooks, () => {}, {applicationForm: true}))).toContain('Remove from my list');
  }
  const remove = jobMenu({jobId: '123', status: 'confirm_required'}, hooks, () => {}, {applicationForm: true}).find(item => item.textContent === 'Remove from my list')!;
  remove.click();
  expect(remove.textContent).toBe('Remove for good? Click again');
  expect(remove.disabled).toBe(false);
}));
