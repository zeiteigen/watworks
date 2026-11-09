import { hostedRequest } from './hosted-client.js';
import type { HostedJob } from './hosted-queue.js';
import { hostedDialog } from './hosted-dialog.js';

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
function postingDetail(job: HostedJob): HTMLElement {
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
function canOpenApplicationForm(status: string): boolean {
  return !['submitted', 'dismissed', 'reserved', 'running', 'executing', 'preparing', 'uploading', 'submitting', 'drafting_cover_letter', 'tailoring_resume'].includes(status);
}
/** Navigation only: the background opens a tab and never touches a form control. */
function waterlooWorksButton(text: string, type: 'openPosting' | 'openApplicationForm', job: HostedJob, report: (value: string) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'secondary'; button.textContent = text;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({type, jobId: job.jobId}) as {ok?: boolean; error?: string} | undefined;
      if (!reply?.ok) throw new Error(reply?.error ?? 'Could not open WaterlooWorks.');
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { button.disabled = false; }
  });
  return button;
}

export function appendHostedJobActions(card: HTMLElement, job: HostedJob, refresh: () => void | Promise<void>, report: (value: string) => void): void {
  const actions = document.createElement('div'), toggle = document.createElement('button');
  const body = document.createElement('div'), source = document.createElement('div');
  source.className = 'actions posting-source'; source.appendChild(waterlooWorksButton('View on WaterlooWorks ↗', 'openPosting', job, report));
  body.append(source, postingDetail(job));
  const modal = hostedDialog(job.posting?.title || `Posting ${job.jobId}`, body);
  actions.className = 'actions job-actions'; toggle.type = 'button'; toggle.className = 'secondary'; toggle.textContent = 'View in detail';
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.addEventListener('click', modal.open);
  actions.appendChild(toggle);
  if (canOpenApplicationForm(job.status)) {
    // Treated as a write so it is disabled while one from this page is still reserving.
    const open = waterlooWorksButton('Open application form ↗', 'openApplicationForm', job, report); open.dataset.write = '';
    actions.appendChild(open);
  }
  if (job.status === 'review' && job.operation === undefined) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary remove-action'; remove.textContent = 'Remove from queue';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/remove`, {method: 'POST', body: '{}'});
        report(`Removed ${job.posting?.title || `posting ${job.jobId}`} from the queue.`); await refresh();
      } catch (error) { report(error instanceof Error ? error.message : String(error)); remove.disabled = false; }
    });
    actions.appendChild(remove);
  }
  card.appendChild(actions); card.appendChild(modal.dialog);
}
