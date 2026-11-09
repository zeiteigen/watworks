import type { ResumeDocument } from "../../workspace/src/schemas.js";

/**
 * A tailored resume is the base resume plus a list of small, reviewable changes.
 * Each change targets one editable line of the base, so any subset of accepted
 * changes (or of the word-level edits inside a rewrite) yields a valid resume.
 *
 * Line ids: `s{section}.e{entry}.b{bullet}` for a bullet, `s{section}.e{entry}` for a
 * whole entry, `s{section}.e{entry}.t` for a project's technologies, `s{section}.g{group}`
 * for a skills group, and `s{section}.i{item}` for a list item.
 */
export type ResumeChange =
  | { id: string; kind: "rewrite"; target: string; before: string; after: string; reason?: string }
  | { id: string; kind: "remove"; target: string; before: string; reason?: string }
  | { id: string; kind: "add"; container: string; before: string | null; text: string; reason?: string };

export interface ResumeLine { id: string; text: string; where: string; editable: "text" | "remove-only"; container?: string }

export const RESUME_REVIEW_MODES = ["whole", "line", "word"] as const;
export type ResumeReviewMode = (typeof RESUME_REVIEW_MODES)[number];

type Entry = { bullets: string[]; technologies?: string | undefined };

function entryName(section: ResumeDocument["sections"][number], entry: unknown): string {
  const value = entry as Record<string, string | undefined>;
  if (section.kind === "experience") return [value.role, value.organization].filter(Boolean).join(", ");
  if (section.kind === "education") return value.institution ?? "";
  if (section.kind === "projects") return value.name ?? "";
  return "";
}

/** Every line a tailoring may rewrite, remove or add next to, in reading order. */
export function resumeLines(resume: ResumeDocument): ResumeLine[] {
  const lines: ResumeLine[] = [];
  resume.sections.forEach((section, s) => {
    if (section.kind === "skills") {
      section.groups.forEach((group, g) => lines.push({ id: `s${s}.g${g}`, text: group.items.join(", "), where: `${section.title} · ${group.label}`, editable: "text" }));
      return;
    }
    if (section.kind === "list") {
      section.items.forEach((item, i) => lines.push({ id: `s${s}.i${i}`, text: item, where: section.title, editable: "text", container: `s${s}` }));
      return;
    }
    (section.entries as Entry[]).forEach((entry, e) => {
      const name = entryName(section, entry), where = `${section.title} · ${name}`;
      lines.push({ id: `s${s}.e${e}`, text: name, where: section.title, editable: "remove-only" });
      if (section.kind === "projects" && entry.technologies) lines.push({ id: `s${s}.e${e}.t`, text: entry.technologies, where: `${where} · technologies`, editable: "text" });
      entry.bullets.forEach((bullet, b) => lines.push({ id: `s${s}.e${e}.b${b}`, text: bullet, where, editable: "text", container: `s${s}.e${e}` }));
    });
  });
  return lines;
}

/** Where a change sits, for the reviewer. */
export function changeLocation(resume: ResumeDocument, change: ResumeChange): string {
  const lines = resumeLines(resume);
  if (change.kind === "add") {
    const container = lines.find(line => line.id === change.container || line.container === change.container);
    const section = resume.sections[Number(/^s(\d+)/.exec(change.container)?.[1])];
    return container?.editable === "remove-only" ? `${section?.title ?? "Resume"} · ${container.text}` : container?.where ?? section?.title ?? "Resume";
  }
  const line = lines.find(item => item.id === change.target);
  return line ? (line.editable === "remove-only" ? `${line.where} · ${line.text}` : line.where) : "Resume";
}

/** Words and the whitespace between them, so joining the tokens restores the text exactly. */
function tokens(text: string): string[] { return text.match(/\s+|[^\s]+/g) ?? []; }

export type WordSegment = { same: string } | { id: string; before: string; after: string };

/**
 * Word-level hunks of one rewrite. Unchanged runs stay fixed; each changed run gets
 * an id `${changeId}.w{n}` that can be accepted on its own.
 */
export function wordDiff(changeId: string, before: string, after: string): WordSegment[] {
  const a = tokens(before), b = tokens(after);
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const raw: Array<{ same: string } | { before: string; after: string }> = [];
  const push = (kind: "same" | "before" | "after", value: string) => {
    const last = raw.at(-1);
    if (kind === "same") { if (last && "same" in last) last.same += value; else raw.push({ same: value }); return; }
    if (last && !("same" in last)) last[kind] += value; else raw.push({ before: "", after: "", [kind]: value } as { before: string; after: string });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push("same", a[i]!); i++; j++; }
    else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) { push("before", a[i]!); i++; }
    else { push("after", b[j]!); j++; }
  }
  // A lone space between two edits joins them, so one rephrasing reads as one hunk.
  const merged: typeof raw = [];
  for (const segment of raw) {
    const gap = merged.at(-1), edit = merged.at(-2);
    if (!("same" in segment) && gap && "same" in gap && /^\s+$/.test(gap.same) && edit && !("same" in edit)) {
      merged.pop(); edit.before += gap.same + segment.before; edit.after += gap.same + segment.after;
    } else merged.push(segment);
  }
  let hunk = 0;
  return merged.map(segment => "same" in segment ? segment : { id: `${changeId}.w${hunk++}`, ...segment });
}

/** The ids a reviewer can toggle: whole changes, or word hunks inside rewrites. */
export function reviewUnits(changes: ResumeChange[], mode: ResumeReviewMode): string[] {
  return changes.flatMap(change => mode === "word" && change.kind === "rewrite"
    ? wordDiff(change.id, change.before, change.after).flatMap(segment => "id" in segment ? [segment.id] : [])
    : [change.id]);
}

function rewritten(change: Extract<ResumeChange, { kind: "rewrite" }>, accepted: ReadonlySet<string>): string {
  if (accepted.has(change.id)) return change.after;
  return wordDiff(change.id, change.before, change.after).map(segment => "same" in segment ? segment.same : accepted.has(segment.id) ? segment.after : segment.before).join("").replace(/\s+/g, " ").trim();
}

/**
 * The base resume with the accepted changes applied. `accepted` holds change ids,
 * word-hunk ids, or both; anything not accepted keeps the base text.
 */
export function applyResumeChanges(base: ResumeDocument, changes: ResumeChange[], acceptedIds: Iterable<string>): ResumeDocument {
  const accepted = new Set(acceptedIds), text = new Map<string, string>(), removed = new Set<string>(), added = new Map<string, Array<{ before: string | null; text: string }>>();
  for (const change of changes) {
    if (change.kind === "rewrite") { const value = rewritten(change, accepted); if (value && value !== change.before) text.set(change.target, value); else if (!value) removed.add(change.target); }
    else if (change.kind === "remove") { if (accepted.has(change.id)) removed.add(change.target); }
    else if (accepted.has(change.id)) added.set(change.container, [...(added.get(change.container) ?? []), { before: change.before, text: change.text }]);
  }
  const lines = (container: string, base: string[], prefix: string) => {
    const extra = added.get(container) ?? [], out: string[] = [];
    base.forEach((value, index) => {
      const id = `${prefix}${index}`;
      for (const item of extra) if (item.before === id) out.push(item.text);
      if (!removed.has(id)) out.push(text.get(id) ?? value);
    });
    for (const item of extra) if (item.before === null || !base.some((_, index) => `${prefix}${index}` === item.before)) out.push(item.text);
    return out;
  };
  const sections = base.sections.flatMap((section, s): Array<ResumeDocument["sections"][number]> => {
    if (section.kind === "skills") {
      const groups = section.groups.flatMap((group, g) => {
        const id = `s${s}.g${g}`;
        if (removed.has(id)) return [];
        const items = text.has(id) ? text.get(id)!.split(/\s*,\s*/).filter(Boolean) : group.items;
        return items.length ? [{ ...group, items }] : [];
      });
      return groups.length ? [{ ...section, groups }] : [];
    }
    if (section.kind === "list") {
      const items = lines(`s${s}`, section.items, `s${s}.i`);
      return items.length ? [{ ...section, items }] : [];
    }
    const entries = (section.entries as Entry[]).flatMap((entry, e) => {
      const id = `s${s}.e${e}`;
      if (removed.has(id)) return [];
      const next: Entry = { ...entry, bullets: lines(id, entry.bullets, `${id}.b`) };
      if (entry.technologies !== undefined) {
        if (removed.has(`${id}.t`)) delete next.technologies; else next.technologies = text.get(`${id}.t`) ?? entry.technologies;
      }
      return [next];
    });
    return entries.length ? [{ ...section, entries } as ResumeDocument["sections"][number]] : [];
  });
  return { heading: base.heading, sections };
}
