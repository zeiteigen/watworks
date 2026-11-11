import { hostedRequest } from './hosted-client.js';
import { hostedJobPending, jobTitle, type HostedJob, type WriteHooks } from './hosted-queue.js';
import { menuItem, openOnWaterlooWorks } from './hosted-step.js';

const fieldNames: Record<string, string> = {
  id: 'Posting ID', organization: 'Employer', workTerm: 'Work term', jobType: 'Job type',
  workArrangement: 'Work arrangement', workTermDuration: 'Work term duration',
  targetedDegreesAndDisciplines: 'Targeted degrees and disciplines',
  preScreening: 'Posting screening questions', serviceTeam: 'Service team',
};
function label(key: string): string {
  return fieldNames[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase());
}

/** Posting content is untrusted: create text nodes only, including URLs and HTML. */
function appendValue(parent: HTMLElement, value: unknown): void {
  if (Array.isArray(value)) {
    const list = document.createElement('ul');
    for (const item of value) { const row = document.createElement('li'); appendValue(row, item); list.appendChild(row); }
    parent.appendChild(list);
  } else if (value && typeof value === 'object') {
    const list = document.createElement('dl');
    for (const [key, field] of Object.entries(value)) appendField(list, key, field);
    parent.appendChild(list);
  } else {
    parent.textContent = typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value ?? 'Not provided');
  }
}
function appendField(list: HTMLElement, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '' || key === 'raw') return;
  const term = document.createElement('dt'), description = document.createElement('dd');
  term.textContent = label(key); appendValue(description, value); list.appendChild(term); list.appendChild(description);
}
export function postingDetail(job: HostedJob): HTMLElement {
  const detail = document.createElement('section'), heading = document.createElement('h4'), fields = document.createElement('dl');
  detail.className = 'posting-content'; heading.textContent = 'Full posting';
  detail.appendChild(heading); appendField(fields, 'id', job.jobId);
  for (const [key, value] of Object.entries(job.posting ?? {})) if (key !== 'id') appendField(fields, key, value);
  if (!job.posting) appendField(fields, 'posting', 'No posting content was saved.');
  if (job.form) {
    for (const key of ['requirements', 'questions', 'externalSteps']) appendField(fields, key, job.form[key]);
  }
  detail.appendChild(fields); return detail;
}

/** A second write from WaterlooWorks must not race one already running, or follow a verified submission. */
export function canOpenApplicationForm(status: string): boolean {
  return !['submitted', 'dismissed', 'reserved', 'running', 'executing', 'preparing', 'uploading', 'submitting', 'drafting_cover_letter', 'tailoring_resume'].includes(status);
}
/** Statuses with nothing in flight; the server checks the same list against its ledger. */
const REMOVABLE = ['review', 'resume_review', 'resume_failed', 'cover_letter_review', 'cover_letter_failed', 'confirm_required', 'uncertain'];
/** Removal only hides the job; its history and no-retry ledger stay. A closed posting must be removable. */
export function canRemoveJob(job: HostedJob): boolean {
  return REMOVABLE.includes(job.status) && !hostedJobPending(job.jobId);
}

/** The menu items every job shares, after the step's own alternatives. */
export function jobMenu(job: HostedJob, hooks: WriteHooks, toggleAbout: () => void, options: { applicationForm: boolean }): HTMLButtonElement[] {
  const items = [menuItem('About this job', toggleAbout), menuItem('View on WaterlooWorks ↗', () => void openOnWaterlooWorks('openPosting', job, hooks.report))];
  if (options.applicationForm && canOpenApplicationForm(job.status)) {
    // Treated as a write so it is disabled while one from this page is still reserving.
    const open = menuItem('Open application form ↗', () => void openOnWaterlooWorks('openApplicationForm', job, hooks.report)); open.dataset.write = '';
    items.push(open);
  }
  if (canRemoveJob(job)) {
    // Past the answers step a removed job cannot come back by preparing it again, so it asks twice.
    let armed = job.status === 'review';
    const remove = menuItem('Remove from my list', async () => {
      if (!armed) { armed = true; remove.textContent = 'Remove for good? Click again'; return; }
      remove.disabled = true;
      try { await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/remove`, {method: 'POST', body: '{}'}); hooks.report(`Removed ${jobTitle(job)}.`); await hooks.refresh(); }
      catch (error) { hooks.report(error instanceof Error ? error.message : String(error), "error"); remove.disabled = false; }
    });
    remove.classList.add('remove-action'); items.push(remove);
  }
  return items;
}
