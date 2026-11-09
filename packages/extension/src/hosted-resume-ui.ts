import { hostedRequest } from './hosted-client.js';
import { hostedDialog } from './hosted-dialog.js';
import { hasHostedCoverSlot } from './hosted-letter-ui.js';
import { changeLocation, reviewUnits, wordDiff, type ResumeChange, type ResumeReviewMode } from '../../shared/src/resume-changes.js';
import type { ResumeDocument } from '../../workspace/src/schemas.js';
import type { HostedJob } from './hosted-queue.js';

export interface HostedCustomResume {
  requested: true; draftId?: string; base?: ResumeDocument; changes?: ResumeChange[]; accepted?: string[];
  pdf?: { name: string; sha256: string }; approved?: { name: string; sha256: string };
}
const TOGGLE_STATUSES = ['review', 'cover_letter_review', 'cover_letter_failed', 'resume_review', 'resume_failed'];

/** Every change, or every word hunk of a rewrite, as one reviewable id. */
function expand(changes: ResumeChange[], ids: Iterable<string>): Set<string> {
  const set = new Set(ids), out = new Set<string>();
  for (const change of changes) {
    const hunks = change.kind === 'rewrite' ? reviewUnits([change], 'word') : [change.id];
    for (const hunk of hunks) if (set.has(change.id) || set.has(hunk)) out.add(hunk);
  }
  return out;
}
/** The smallest description of a choice set: whole changes where every hunk is kept. */
function compact(changes: ResumeChange[], hunks: Set<string>): string[] {
  return changes.flatMap(change => {
    if (change.kind !== 'rewrite') return hunks.has(change.id) ? [change.id] : [];
    const units = reviewUnits([change], 'word');
    return units.every(unit => hunks.has(unit)) ? [change.id] : units.filter(unit => hunks.has(unit));
  });
}
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(id => b.has(id));

/** Unapplied choices survive the queue's re-renders, keyed by the draft they belong to. */
const choices = new Map<string, { draftId: string; hunks: Set<string> }>();
function choiceState(job: HostedJob, custom: HostedCustomResume): Set<string> {
  const saved = choices.get(job.jobId);
  if (saved && saved.draftId === custom.draftId) return saved.hunks;
  const hunks = expand(custom.changes ?? [], custom.accepted ?? []);
  choices.set(job.jobId, { draftId: custom.draftId!, hunks }); return hunks;
}

function text(tag: string, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node;
}

/** Model output is untrusted: only text nodes, never HTML. */
export function renderResumeChanges(custom: HostedCustomResume, mode: ResumeReviewMode, kept: Set<string>, onChange: () => void): HTMLElement {
  const list = document.createElement('ol'); list.className = 'resume-changes';
  const interactive = mode !== 'whole';
  for (const change of custom.changes ?? []) {
    const row = document.createElement('li'), head = document.createElement('div'), body = document.createElement('p');
    row.className = `resume-change change-${change.kind}`; head.className = 'change-head'; body.className = 'change-text';
    const hunks = change.kind === 'rewrite' ? reviewUnits([change], 'word') : [change.id];
    const allKept = () => hunks.every(id => kept.has(id));
    if (interactive) {
      const label = document.createElement('label'), box = document.createElement('input');
      label.className = 'change-keep'; box.type = 'checkbox'; box.checked = allKept();
      box.indeterminate = !box.checked && hunks.some(id => kept.has(id));
      box.setAttribute('aria-label', `Keep change: ${change.kind === 'add' ? 'added line' : change.kind === 'remove' ? 'removed line' : 'rewritten line'} in ${custom.base ? changeLocation(custom.base, change) : 'resume'}`);
      box.addEventListener('change', () => { for (const id of hunks) if (box.checked) kept.add(id); else kept.delete(id); onChange(); });
      label.append(box, text('span', 'Keep'));
      head.appendChild(label);
    }
    head.appendChild(text('span', custom.base ? changeLocation(custom.base, change) : 'Resume', 'change-where'));
    head.appendChild(text('span', change.kind === 'add' ? 'Added' : change.kind === 'remove' ? 'Removed' : 'Rewritten', 'change-kind'));
    if (change.kind === 'add') body.appendChild(text('ins', change.text));
    else if (change.kind === 'remove') body.appendChild(text('del', change.before));
    else for (const segment of wordDiff(change.id, change.before, change.after)) {
      if ('same' in segment) { body.appendChild(document.createTextNode(segment.same)); continue; }
      const clickable = interactive && mode === 'word', hunk = document.createElement(clickable ? 'button' : 'span') as HTMLButtonElement;
      hunk.className = `word-hunk${kept.has(segment.id) ? '' : ' rejected'}`;
      if (segment.before) hunk.appendChild(text('del', segment.before));
      if (segment.after) hunk.appendChild(text('ins', segment.after));
      if (clickable) {
        hunk.type = 'button'; hunk.setAttribute('aria-pressed', String(kept.has(segment.id)));
        hunk.title = kept.has(segment.id) ? 'Kept. Click to keep the original words.' : 'Original kept. Click to use the new words.';
        hunk.setAttribute('aria-label', `${segment.before ? `Replace “${segment.before.trim()}”` : 'Insert'}${segment.after ? ` with “${segment.after.trim()}”` : ' by removing it'}: ${kept.has(segment.id) ? 'kept' : 'not kept'}`);
        hunk.addEventListener('click', () => { if (kept.has(segment.id)) kept.delete(segment.id); else kept.add(segment.id); onChange(); });
      }
      body.appendChild(hunk);
    }
    if (interactive && !allKept() && hunks.every(id => !kept.has(id))) row.classList.add('change-off');
    row.append(head, body);
    if (change.reason) row.appendChild(text('p', change.reason, 'change-reason'));
    list.appendChild(row);
  }
  return list;
}

function previewButton(job: HostedJob, label: string, report: (value: string) => void, tex = false): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const blob = await hostedRequest<Blob>(`/jobs/${encodeURIComponent(job.jobId)}/custom-resume${tex ? '?tex=1' : ''}`), url = URL.createObjectURL(blob);
      if (tex) { const link = document.createElement('a'); link.href = url; link.download = `custom-resume-${job.jobId}.tex`; link.click(); }
      else await chrome.tabs.create({ url });
      setTimeout(() => URL.revokeObjectURL(url), 300_000);
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { button.disabled = false; }
  });
  return button;
}

export function customResumeApprovalLabel(job: HostedJob): string {
  if (hasHostedCoverSlot(job)) return job.coverLetter ? 'Approve custom resume' : 'Approve custom resume and draft cover letter';
  return 'Approve custom resume and application uploads';
}

/** Custom resume controls for one job card. Uploads still happen only through `approve`. */
export function appendCustomResume(
  parent: HTMLElement, job: HostedJob, mode: ResumeReviewMode, refresh: () => void | Promise<void>, report: (value: string) => void,
  approve: (hash?: string) => Promise<void>, busy: boolean,
): void {
  const custom = job.customResume;
  const canToggle = TOGGLE_STATUSES.includes(job.status) && !(job.coverLetter?.source === 'generated') && !custom?.approved && Boolean(job.resumeId);
  if (!custom && !canToggle) return;
  const section = document.createElement('section'); section.className = 'job-detail custom-resume';
  section.appendChild(text('h4', 'Custom resume'));
  if (canToggle) {
    const label = document.createElement('label'), box = document.createElement('input');
    label.className = 'check-option custom-resume-toggle'; box.type = 'checkbox'; box.checked = Boolean(custom); box.disabled = busy;
    label.append(box, text('span', 'Send with custom resume'));
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/custom-resume`, { method: 'POST', body: JSON.stringify({ enabled: box.checked }) });
        choices.delete(job.jobId);
        report(box.checked ? 'A custom resume will be drafted for this job when you approve it.' : 'This job will use the selected base resume.');
        await refresh();
      } catch (error) { box.checked = !box.checked; report(error instanceof Error ? error.message : String(error)); }
      finally { box.disabled = false; }
    });
    section.appendChild(label);
  }
  const note = (value: string) => section.appendChild(text('p', value, 'meta'));
  if (!custom) { note('Tailors the selected resume to this posting with your custom resume prompt. You review the changes before anything is uploaded.'); parent.appendChild(section); return; }
  if (custom.approved) {
    note(`Approved: ${custom.approved.name}. This version replaces the base resume in the application.`);
    section.appendChild(previewButton(job, 'Preview approved resume', report));
    parent.appendChild(section); return;
  }
  if (job.status === 'tailoring_resume') { note('Tailoring your resume and typesetting it with LaTeX…'); parent.appendChild(section); return; }
  if (job.status === 'resume_failed') {
    note(job.customResumeError || 'The custom resume could not be drafted.');
    const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.write = ''; retry.textContent = 'Request a new custom resume';
    retry.addEventListener('click', async () => { retry.disabled = true; try { await approve(); } finally { retry.disabled = false; } });
    section.appendChild(retry); parent.appendChild(section); return;
  }
  if (job.status !== 'resume_review' || !custom.pdf || !custom.changes) { note('A custom version of the selected resume is drafted when you approve this application.'); parent.appendChild(section); return; }

  const changes = custom.changes, kept = choiceState(job, custom), applied = expand(changes, custom.accepted ?? []);
  const dirty = () => !same(kept, applied);
  note(changes.length ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} from your base resume. ${mode === 'whole' ? 'Review them and the PDF, then approve.' : 'Choose which to keep, apply your choices, then approve the PDF.'}` : 'No changes were needed for this posting. Preview the PDF, then approve it or send the base resume.');
  const actions = document.createElement('div'); actions.className = 'actions';
  actions.append(previewButton(job, 'Preview custom resume PDF', report), previewButton(job, 'Download LaTeX source', report, true));
  section.appendChild(actions);
  if (changes.length) {
    const body = document.createElement('div'), modal = hostedDialog(mode === 'whole' ? 'Custom resume changes' : 'Choose resume changes', body);
    const status = text('p', '', 'meta'); status.setAttribute('role', 'status');
    const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply my choices';
    const draw = () => {
      body.replaceChildren();
      if (mode === 'word') body.appendChild(text('p', 'Click a highlighted edit to switch between the new words and your original words.', 'meta'));
      body.appendChild(renderResumeChanges(custom, mode, kept, draw));
      if (mode !== 'whole') { apply.disabled = !dirty(); status.textContent = dirty() ? 'You have choices that are not applied to the PDF yet.' : 'The PDF matches these choices.'; body.append(status, apply); }
    };
    apply.addEventListener('click', async () => {
      apply.disabled = true; status.textContent = 'Rebuilding your resume…';
      try {
        await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/custom-resume/choices`, { method: 'POST', body: JSON.stringify({ draftId: custom.draftId, accepted: compact(changes, kept) }) });
        modal.close(); report('Custom resume rebuilt with your choices. Preview it, then approve it.'); await refresh();
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); apply.disabled = false; }
    });
    draw();
    const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.setAttribute('aria-haspopup', 'dialog');
    const keptCount = changes.filter(change => (change.kind === 'rewrite' ? reviewUnits([change], 'word') : [change.id]).some(id => applied.has(id))).length;
    open.textContent = mode === 'whole' ? `View ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}` : `Review changes (${keptCount}/${changes.length} kept)`;
    open.addEventListener('click', () => { draw(); modal.open(); });
    actions.appendChild(open); section.appendChild(modal.dialog);
  }
  if (dirty()) note('Your unapplied choices are not in the PDF yet. Open Review changes and apply them before approving.');
  const approveButton = document.createElement('button'); approveButton.type = 'button'; approveButton.dataset.write = ''; approveButton.textContent = customResumeApprovalLabel(job);
  approveButton.disabled = dirty();
  approveButton.addEventListener('click', async () => { approveButton.disabled = true; try { await approve(custom.pdf!.sha256); } finally { approveButton.disabled = dirty(); } });
  section.appendChild(approveButton);
  parent.appendChild(section);
}
