import { hostedRequest } from './hosted-client.js';
import { changeLocation, markupLink, reviewUnit, reviewUnits, wordDiff, type ResumeChange, type ResumeReviewMode } from '../../shared/src/resume-changes.js';
import { renderPdf } from './hosted-pdf.js';
import type { ResumeDocument } from '../../workspace/src/schemas.js';
import { approveDocument, hasHostedCoverSlot, type HostedJob, type WriteHooks } from './hosted-queue.js';
import { button, cachedPdf, menuItem, openHostedFile, text, writeButton, type StepContext, type StepView } from './hosted-step.js';

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

export function customResumeApprovalLabel(job: HostedJob): string {
  if (hasHostedCoverSlot(job)) return job.coverLetter ? 'Approve resume and upload' : 'Approve resume and draft letter';
  return 'Approve resume and upload';
}
function customResumeNext(job: HostedJob): string {
  return hasHostedCoverSlot(job) && !job.coverLetter ? 'WatWorks writes your cover letter from this resume next. Nothing is sent until you approve it.' : 'This uploads exactly this PDF to WaterlooWorks. Nothing is submitted until your final check.';
}

/** Whether the job can still switch between its base resume and a tailored one. */
export function canTailorResume(job: HostedJob): boolean {
  return TOGGLE_STATUSES.includes(job.status) && job.coverLetter?.source !== 'generated' && !job.customResume?.approved && Boolean(job.resumeId);
}
async function setCustomResume(job: HostedJob, enabled: boolean, hooks: WriteHooks): Promise<void> {
  await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/custom-resume`, { method: 'POST', body: JSON.stringify({ enabled }) });
  choices.delete(job.jobId);
  hooks.report(enabled ? 'WatWorks will tailor your resume for this job when you continue.' : 'This job will use your base resume.');
  await hooks.refresh();
}
/** "Tailor it for this job": nothing is drafted until the application is approved. */
export function customResumeToggle(job: HostedJob, hooks: WriteHooks, busy: boolean): HTMLElement | null {
  if (!canTailorResume(job)) return null;
  const label = document.createElement('label'), box = document.createElement('input');
  label.className = 'check-option custom-resume-toggle'; box.type = 'checkbox'; box.checked = Boolean(job.customResume); box.disabled = busy;
  label.append(box, text('span', 'Tailor it for this job'));
  box.addEventListener('change', async () => {
    box.disabled = true;
    try { await setCustomResume(job, box.checked, hooks); }
    catch (error) { box.checked = !box.checked; hooks.report(error instanceof Error ? error.message : String(error), "error"); }
    finally { box.disabled = false; }
  });
  return label;
}
function useBaseResume(job: HostedJob, hooks: WriteHooks): HTMLButtonElement[] {
  return canTailorResume(job) ? [menuItem('Use my base resume instead', () => void setCustomResume(job, false, hooks).catch(error => hooks.report(error instanceof Error ? error.message : String(error), "error")))] : [];
}

/**
 * The tailored resume opens on the PDF itself: every proposed change is drawn in place and
 * clicking one keeps or drops it. Choices are applied (a rebuild, never a WaterlooWorks write)
 * before the exact clean PDF can be approved.
 */
export function resumeStep(job: HostedJob, ctx: StepContext): StepView {
  const custom = job.customResume!, hooks = ctx.hooks, mode = ctx.reviewMode;
  const path = `/jobs/${encodeURIComponent(job.jobId)}/custom-resume`, body = document.createElement('div'); body.className = 'resume-step';
  const menu = useBaseResume(job, hooks);
  if (job.status === 'resume_failed' || !custom.pdf || !custom.changes) {
    body.append(text('p', 'Your tailored resume couldn’t be built:', 'meta'), text('pre', job.customResumeError || 'No reason was given.', 'error-box'));
    return { body, primary: writeButton('Try again', () => ctx.act(() => approveDocument(job, hooks, {}))), help: 'Or send your base resume from ⋯.', menu };
  }
  menu.push(menuItem('Download LaTeX source', () => void openHostedFile(`${path}?tex=1`, hooks.report, `custom-resume-${job.jobId}.tex`)));
  menu.push(menuItem('Open the PDF in a new tab', () => void openHostedFile(path, hooks.report)));
  const changes = custom.changes;
  // Reads the hash at click time: applying choices replaces the PDF without a re-render.
  const doApprove = () => ctx.act(() => approveDocument(job, hooks, { customResumeHash: custom.pdf!.sha256 }));
  const final = document.createElement('div'); final.className = 'pdf-review document';
  let finalShown: string | undefined;
  const loadFinal = () => {
    const sha = custom.pdf!.sha256;
    if (finalShown === sha) return;
    finalShown = sha; final.replaceChildren(text('p', 'Loading your resume…', 'meta pdf-loading'));
    void cachedPdf(`pdf:${sha}`, path).then(async bytes => { final.replaceChildren(); await renderPdf(final, bytes, 'Your tailored resume'); })
      .catch(error => { finalShown = undefined; final.replaceChildren(text('p', `The PDF could not be shown here: ${error instanceof Error ? error.message : String(error)}`, 'meta pdf-loading')); });
  };
  if (!changes.length) {
    body.append(text('p', 'No changes were needed for this posting. This is the resume that will be sent.', 'meta'), final); loadFinal();
    return { body, primary: writeButton(customResumeApprovalLabel(job), doApprove), help: customResumeNext(job), menu, wide: true };
  }

  let applied = expand(changes, custom.accepted ?? []);
  const kept = choiceState(job, custom), dirty = () => !same(kept, applied);
  const keptCount = () => changes.filter(change => hunksOf(change).some(id => kept.has(id))).length;
  const hint = text('p', mode === 'word' ? 'Click a highlighted edit to keep or drop it.' : 'Click a highlighted change to keep or drop it.', 'meta review-hint');
  const count = text('p', '', 'review-count');
  const marked = document.createElement('div'); marked.className = 'pdf-review document';
  const list = document.createElement('div'); list.className = 'resume-review-list'; list.hidden = true;
  final.hidden = true;
  const view = button('See the clean PDF', () => show(final.hidden ? 'final' : 'marked'), 'link view-toggle');
  body.append(hint, count, marked, final, list, view);
  const primary = document.createElement('button'); primary.type = 'button';
  const helpLine = { text: '' };

  let marks: Mark[] = [];
  const focus = (changeId: string | null) => {
    for (const mark of marks) mark.element.classList.toggle('focus', mark.change.id === changeId);
    for (const row of list.querySelectorAll<HTMLElement>('[data-change]')) row.classList.toggle('focus', row.dataset.change === changeId);
  };
  const draw = () => {
    if (!list.hidden) list.replaceChildren(renderResumeChanges(custom, mode, kept, draw, focus));
    paintMarks(marks, custom, kept);
    count.textContent = `${keptCount()} of ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} kept${dirty() ? ' · not in the PDF yet' : ''}`;
    // One primary: rebuild first when the choices changed, then approve that exact PDF.
    const rebuild = dirty();
    primary.textContent = rebuild ? 'Apply my choices' : customResumeApprovalLabel(job);
    if (rebuild) delete primary.dataset.write; else primary.dataset.write = '';
    const help = card()?.querySelector<HTMLElement>('.step-help');
    helpLine.text = rebuild ? 'Applying rebuilds the PDF with your choices. Nothing is sent.' : customResumeNext(job);
    if (help) help.textContent = helpLine.text;
  };
  const card = () => body.closest<HTMLElement>('.task-card');
  const toggle = (unit: string) => { toggleUnit(changes, kept, unit); draw(); };
  const showList = () => { list.hidden = false; draw(); list.scrollIntoView?.({ block: 'nearest' }); };
  menu.unshift(menuItem('Show the changes as a list', showList));
  const show = (which: 'marked' | 'final') => {
    marked.hidden = which !== 'marked'; final.hidden = which !== 'final'; hint.hidden = which !== 'marked';
    view.textContent = which === 'marked' ? 'See the clean PDF' : 'See the changes';
    if (which === 'final') loadFinal();
  };
  marked.replaceChildren(text('p', 'Loading your resume with the changes marked…', 'meta pdf-loading'));
  void drawMarkedPdf(marked, custom, mode, job.jobId, toggle, focus).then(found => {
    marks = found; draw();
    // A server without review copies answers with the plain build, which has no change links.
    if (!marks.length) { marked.prepend(text('p', 'This PDF has no changes marked on it. Keep or drop them in the list instead.', 'meta pdf-loading')); showList(); }
  }).catch(error => {
    marked.replaceChildren(text('p', `The marked-up PDF could not be shown: ${error instanceof Error ? error.message : String(error)} Keep or drop changes in the list instead.`, 'meta pdf-loading'));
    showList();
  });
  primary.addEventListener('click', async () => {
    if (!dirty()) { doApprove(); return; }
    primary.disabled = true; count.textContent = 'Rebuilding your resume…';
    try {
      const result = await hostedRequest<{ customResume: HostedCustomResume }>(`${path}/choices`, { method: 'POST', body: JSON.stringify({ draftId: custom.draftId, accepted: compact(changes, kept) }) });
      // The approval below must name the new build, even before the next refresh arrives.
      if (result.customResume.pdf) custom.pdf = result.customResume.pdf;
      custom.accepted = result.customResume.accepted ?? []; applied = expand(changes, custom.accepted);
      show('final'); hooks.report('Resume rebuilt with your choices. Check it, then approve it.');
    } catch (error) { hooks.report(error instanceof Error ? error.message : String(error), "error"); }
    finally { primary.disabled = false; draw(); }
  });
  draw();
  return { body, primary, help: helpLine.text, menu, wide: true };
}
