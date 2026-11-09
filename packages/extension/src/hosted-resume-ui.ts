import { hostedRequest } from './hosted-client.js';
import { hostedDialog } from './hosted-dialog.js';
import { hasHostedCoverSlot } from './hosted-letter-ui.js';
import { changeLocation, markupLink, reviewUnit, reviewUnits, wordDiff, type ResumeChange, type ResumeReviewMode } from '../../shared/src/resume-changes.js';
import { renderPdf } from './hosted-pdf.js';
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

const hunksOf = (change: ResumeChange) => change.kind === 'rewrite' ? reviewUnits([change], 'word') : [change.id];
const kindLabel = (change: ResumeChange) => change.kind === 'add' ? 'Added' : change.kind === 'remove' ? 'Removed' : 'Rewritten';

/** Keeps every hunk of a unit, or drops them all when every one is kept. */
function toggleUnit(changes: ResumeChange[], kept: Set<string>, unit: string): void {
  const change = changes.find(item => item.id === unit.split('.')[0]);
  const hunks = unit.includes('.') ? [unit] : change ? hunksOf(change) : [unit];
  const keep = !hunks.every(id => kept.has(id));
  for (const id of hunks) if (keep) kept.add(id); else kept.delete(id);
}

/** Model output is untrusted: only text nodes, never HTML. Every change can be kept or dropped. */
export function renderResumeChanges(custom: HostedCustomResume, mode: ResumeReviewMode, kept: Set<string>, onChange: () => void, onFocus: (changeId: string | null) => void = () => {}): HTMLElement {
  const list = document.createElement('ol'); list.className = 'resume-changes';
  (custom.changes ?? []).forEach((change, index) => {
    const row = document.createElement('li'), head = document.createElement('div'), body = document.createElement('p');
    row.className = `resume-change change-${change.kind}`; row.dataset.change = change.id; head.className = 'change-head'; body.className = 'change-text';
    row.addEventListener('mouseenter', () => onFocus(change.id)); row.addEventListener('mouseleave', () => onFocus(null));
    const hunks = hunksOf(change), allKept = () => hunks.every(id => kept.has(id));
    const where = custom.base ? changeLocation(custom.base, change) : 'Resume';
    const label = document.createElement('label'), box = document.createElement('input');
    label.className = 'change-keep'; box.type = 'checkbox'; box.checked = allKept();
    box.indeterminate = !box.checked && hunks.some(id => kept.has(id));
    box.setAttribute('aria-label', `Keep change ${index + 1}: ${kindLabel(change).toLowerCase()} line in ${where}`);
    box.addEventListener('change', () => { for (const id of hunks) if (box.checked) kept.add(id); else kept.delete(id); onChange(); });
    label.append(box, text('span', 'Keep'));
    head.append(text('span', String(index + 1), 'change-number'), label, text('span', where, 'change-where'), text('span', kindLabel(change), 'change-kind'));
    if (change.kind === 'add') body.appendChild(text('ins', change.text));
    else if (change.kind === 'remove') body.appendChild(text('del', change.before));
    else for (const segment of wordDiff(change.id, change.before, change.after)) {
      if ('same' in segment) { body.appendChild(document.createTextNode(segment.same)); continue; }
      const clickable = mode === 'word', hunk = document.createElement(clickable ? 'button' : 'span') as HTMLButtonElement;
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
    if (hunks.every(id => !kept.has(id))) row.classList.add('change-off');
    row.append(head, body);
    if (change.reason) row.appendChild(text('p', change.reason, 'change-reason'));
    list.appendChild(row);
  });
  return list;
}

/** PDFs already fetched this session: review copies by draft, built resumes by hash. */
const pdfCache = new Map<string, Promise<Uint8Array>>();
function cachedPdf(key: string, path: string): Promise<Uint8Array> {
  let pending = pdfCache.get(key);
  if (!pending) {
    pending = hostedRequest<Blob>(path).then(async blob => new Uint8Array(await blob.arrayBuffer()));
    pdfCache.set(key, pending); pending.catch(() => pdfCache.delete(key));
  }
  return pending;
}

interface Mark { element: HTMLButtonElement; hunk: string; unit: string; change: ResumeChange; side: 'del' | 'ins' }

/**
 * Draws the marked-up review copy and lays a button over every change on the page.
 * Clicking one keeps or drops it; the overlay shows which text the next build will use.
 */
async function drawMarkedPdf(pane: HTMLElement, custom: HostedCustomResume, mode: ResumeReviewMode, jobId: string, toggle: (unit: string) => void, focus: (changeId: string | null) => void): Promise<Mark[]> {
  const bytes = await cachedPdf(`markup:${custom.draftId}`, `/jobs/${encodeURIComponent(jobId)}/custom-resume?markup=1`);
  pane.replaceChildren();
  const links = await renderPdf(pane, bytes, 'Resume with proposed changes marked'), changes = custom.changes ?? [], marks: Mark[] = [];
  const badges = new Map<HTMLElement, Array<{ top: number; numbers: number[] }>>(), numbered = new Set<string>();
  for (const link of links) {
    const parsed = markupLink(link.url), change = parsed && changes.find(item => item.id === parsed.hunk.split('.')[0]);
    if (!parsed || !change) continue;
    const element = document.createElement('button'); element.type = 'button'; element.className = `pdf-mark ${parsed.side}`;
    Object.assign(element.style, { left: `${link.left}%`, top: `${link.top}%`, width: `${link.width}%`, height: `${link.height}%` });
    const unit = reviewUnit(parsed.hunk, mode);
    element.addEventListener('click', () => toggle(unit));
    element.addEventListener('mouseenter', () => focus(change.id)); element.addEventListener('mouseleave', () => focus(null));
    link.page.appendChild(element); marks.push({ element, hunk: parsed.hunk, unit, change, side: parsed.side });
    if (numbered.has(change.id)) continue;
    // Each change is numbered once, in the page margin beside its first line, to match the list.
    numbered.add(change.id);
    const rows = badges.get(link.page) ?? [], number = changes.indexOf(change) + 1, row = rows.find(item => Math.abs(item.top - link.top) < 1);
    if (row) row.numbers.push(number); else rows.push({ top: link.top, numbers: [number] });
    badges.set(link.page, rows);
  }
  for (const [page, rows] of badges) for (const row of rows) {
    const badge = text('span', row.numbers.join(','), 'pdf-badge'); badge.style.top = `${row.top}%`; badge.setAttribute('aria-hidden', 'true'); page.appendChild(badge);
  }
  return marks;
}

function paintMarks(marks: Mark[], custom: HostedCustomResume, kept: Set<string>): void {
  const changes = custom.changes ?? [];
  for (const mark of marks) {
    const isKept = kept.has(mark.hunk), number = changes.indexOf(mark.change) + 1;
    mark.element.classList.toggle('kept', isKept); mark.element.classList.toggle('dropped', !isKept);
    const shows = mark.side === 'ins' ? (isKept ? 'This new text is kept' : 'This new text is dropped') : (isKept ? 'This original text is removed' : 'This original text is kept');
    const where = custom.base ? changeLocation(custom.base, mark.change) : 'Resume';
    mark.element.setAttribute('aria-pressed', String(isKept));
    mark.element.setAttribute('aria-label', `Change ${number}, ${kindLabel(mark.change).toLowerCase()} in ${where}: ${shows}. Click to ${isKept ? 'drop' : 'keep'} it.`);
    mark.element.title = `${number}. ${kindLabel(mark.change)} · ${where}\n${shows}. Click to ${isKept ? 'drop' : 'keep'} ${mark.unit.includes('.') ? 'this edit' : 'this change'}.${mark.change.reason ? `\n${mark.change.reason}` : ''}`;
  }
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

  const changes = custom.changes;
  let applied = expand(changes, custom.accepted ?? []);
  const kept = choiceState(job, custom), dirty = () => !same(kept, applied);
  note(changes.length ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} from your base resume. Review them on the marked-up PDF, keep or drop each one, apply your choices, then approve.` : 'No changes were needed for this posting. Preview the PDF, then approve it or send the base resume.');
  const actions = document.createElement('div'); actions.className = 'actions';
  // With changes, the preview is the marked-up PDF below; the plain build stays one tab away in it.
  if (!changes.length) actions.appendChild(previewButton(job, 'Preview custom resume PDF', report));
  actions.appendChild(previewButton(job, 'Download LaTeX source', report, true));
  section.appendChild(actions);
  if (changes.length) {
    const body = document.createElement('div'); body.className = 'resume-review';
    const modal = hostedDialog('Review custom resume changes', body); modal.dialog.classList.add('wide');
    const tabs = document.createElement('div'), showMarked = document.createElement('button'), showFinal = document.createElement('button');
    tabs.className = 'review-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Preview');
    for (const [button, label] of [[showMarked, 'Changes marked'], [showFinal, 'Final PDF']] as const) { button.type = 'button'; button.className = 'secondary'; button.textContent = label; tabs.appendChild(button); }
    const hint = text('p', mode === 'word'
      ? 'Click a highlighted edit on the page, or in the list, to keep or drop it. Each edited phrase is its own choice.'
      : 'Click a highlighted change on the page, or in the list, to keep or drop it.', 'meta');
    const legend = document.createElement('p'); legend.className = 'review-legend meta';
    legend.append(text('span', 'New text', 'legend-ins'), text('span', 'Removed text', 'legend-del'), text('span', 'Faded: not in the final resume', 'legend-off'));
    const grid = document.createElement('div'), marked = document.createElement('div'), final = document.createElement('div'), side = document.createElement('div');
    grid.className = 'resume-review-grid'; marked.className = 'pdf-review'; final.className = 'pdf-review'; final.hidden = true; side.className = 'resume-review-list';
    grid.append(marked, final, side);
    const status = text('p', '', 'meta'); status.setAttribute('role', 'status');
    const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply my choices';
    const footer = document.createElement('div'); footer.className = 'review-footer'; footer.append(status, apply);
    body.append(tabs, hint, legend, grid, footer);

    let marks: Mark[] = [], loaded: Promise<void> | undefined, finalShown: string | undefined;
    const focus = (changeId: string | null) => {
      for (const mark of marks) mark.element.classList.toggle('focus', mark.change.id === changeId);
      for (const row of side.querySelectorAll<HTMLElement>('[data-change]')) row.classList.toggle('focus', row.dataset.change === changeId);
    };
    const draw = () => {
      side.replaceChildren(renderResumeChanges(custom, mode, kept, draw, focus));
      paintMarks(marks, custom, kept);
      apply.disabled = !dirty();
      status.textContent = dirty() ? 'You have choices that are not in the final PDF yet.' : 'The final PDF matches these choices.';
    };
    const toggle = (unit: string) => { toggleUnit(changes, kept, unit); draw(); };
    const loadMarked = () => loaded ??= (async () => {
      marked.replaceChildren(text('p', 'Loading the resume with changes marked…', 'meta pdf-loading'));
      try {
        marks = await drawMarkedPdf(marked, custom, mode, job.jobId, toggle, focus); draw();
        // A server without review copies answers with the plain build, which has no change links.
        if (!marks.length) marked.prepend(text('p', 'This preview has no changes marked in it, so the WatWorks server has not been updated yet. Keep or drop changes in the list for now.', 'meta pdf-loading'));
      }
      catch (error) {
        loaded = undefined;
        marked.replaceChildren(text('p', `The marked-up PDF could not be shown: ${error instanceof Error ? error.message : String(error)} You can still keep or drop each change in the list.`, 'meta pdf-loading'));
      }
    })();
    const loadFinal = async () => {
      const sha = custom.pdf!.sha256;
      if (finalShown === sha) return;
      finalShown = sha; final.replaceChildren(text('p', 'Loading the final PDF…', 'meta pdf-loading'));
      try { const bytes = await cachedPdf(`pdf:${sha}`, `/jobs/${encodeURIComponent(job.jobId)}/custom-resume`); final.replaceChildren(); await renderPdf(final, bytes, 'Final custom resume'); }
      catch (error) { finalShown = undefined; final.replaceChildren(text('p', `The final PDF could not be shown: ${error instanceof Error ? error.message : String(error)}`, 'meta pdf-loading')); }
    };
    const show = (which: 'marked' | 'final') => {
      marked.hidden = which !== 'marked'; final.hidden = which !== 'final';
      showMarked.setAttribute('aria-pressed', String(which === 'marked')); showFinal.setAttribute('aria-pressed', String(which === 'final'));
      hint.hidden = legend.hidden = which !== 'marked';
      void (which === 'marked' ? loadMarked() : loadFinal());
    };
    showMarked.addEventListener('click', () => show('marked')); showFinal.addEventListener('click', () => show('final'));
    apply.addEventListener('click', async () => {
      apply.disabled = true; status.textContent = 'Rebuilding your resume…';
      try {
        const result = await hostedRequest<{ customResume: HostedCustomResume }>(`/jobs/${encodeURIComponent(job.jobId)}/custom-resume/choices`, { method: 'POST', body: JSON.stringify({ draftId: custom.draftId, accepted: compact(changes, kept) }) });
        // The card re-renders when the dialog closes; until then the approval below must use the new build.
        if (result.customResume.pdf) custom.pdf = result.customResume.pdf;
        custom.accepted = result.customResume.accepted ?? []; applied = expand(changes, custom.accepted ?? []);
        draw(); status.textContent = 'Applied. This is the final PDF. Close this window to approve it.'; show('final');
        report('Custom resume rebuilt with your choices. Check the final PDF, then approve it.'); await refresh();
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); apply.disabled = !dirty(); }
    });
    draw();
    const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.setAttribute('aria-haspopup', 'dialog');
    const keptCount = changes.filter(change => hunksOf(change).some(id => applied.has(id))).length;
    open.textContent = `Preview PDF with changes marked (${keptCount}/${changes.length} kept)`;
    open.addEventListener('click', () => { draw(); modal.open(); show('marked'); });
    actions.appendChild(open); section.appendChild(modal.dialog);
  }
  if (dirty()) note('Your unapplied choices are not in the PDF yet. Open the PDF preview and apply them before approving.');
  const approveButton = document.createElement('button'); approveButton.type = 'button'; approveButton.dataset.write = ''; approveButton.textContent = customResumeApprovalLabel(job);
  approveButton.disabled = dirty();
  approveButton.addEventListener('click', async () => { approveButton.disabled = true; try { await approve(custom.pdf!.sha256); } finally { approveButton.disabled = dirty(); } });
  section.appendChild(approveButton);
  parent.appendChild(section);
}
