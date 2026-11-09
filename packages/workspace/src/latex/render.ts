import type { CoverLetter, JobDocument, Profile, ResumeDocument, ResumeSection } from "../schemas.js";

const BODY_MARKER = "%%WAT:BODY%%";

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
  "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", "<": "\\textless{}", ">": "\\textgreater{}",
};

/** Escape untrusted text so it can never inject LaTeX commands. */
export function escapeLatex(value: string): string {
  return value.replace(/[\\&%$#_{}~^<>]/g, char => ESCAPES[char]!).replace(/[\r\n]+/g, " ");
}

/** Escape text, then turn **bold** spans into \textbf{}. */
export function inline(value: string): string {
  return value.split(/\*\*(.+?)\*\*/g).map((part, index) => index % 2 ? `\\textbf{${escapeLatex(part)}}` : escapeLatex(part)).join("");
}

const LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Links reach \href nearly verbatim, so anything TeX could reinterpret is percent-encoded.
 * That includes ^, because TeX reads ^^7d as a closing brace and ^^5c as a backslash.
 */
function url(value: string): string {
  const link = value.trim();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(link)?.[1]?.toLowerCase();
  if (scheme && !LINK_SCHEMES.has(scheme)) throw new Error(`Unsupported link scheme "${scheme}": use http, https, mailto, or tel`);
  return link
    .replace(/[^\x21-\x7e]|[\\{}^`<>"|]/gu, encodeURIComponent)
    .replace(/[%#]/g, char => `\\${char}`);
}

function itemList(bullets: readonly string[]): string[] {
  if (!bullets.length) return [];
  return ["      \\resumeItemListStart", ...bullets.map(bullet => `        \\resumeItem{${inline(bullet)}}`), "      \\resumeItemListEnd"];
}

function section(value: ResumeSection): string[] {
  const out = [`\\section{${escapeLatex(value.title)}}`];
  switch (value.kind) {
    case "education":
      out.push("  \\resumeSubHeadingListStart");
      for (const entry of value.entries) {
        out.push(`    \\resumeSubheading{${escapeLatex(entry.institution)}}{${escapeLatex(entry.location ?? "")}}{${escapeLatex(entry.degree)}}{${escapeLatex(entry.dates ?? "")}}`, ...itemList(entry.bullets));
      }
      out.push("  \\resumeSubHeadingListEnd");
      break;
    case "experience":
      out.push("  \\resumeSubHeadingListStart");
      for (const entry of value.entries) {
        out.push(`    \\resumeSubheading{${escapeLatex(entry.role)}}{${escapeLatex(entry.dates ?? "")}}{${escapeLatex(entry.organization)}}{${escapeLatex(entry.location ?? "")}}`, ...itemList(entry.bullets));
      }
      out.push("  \\resumeSubHeadingListEnd");
      break;
    case "projects":
      out.push("  \\resumeSubHeadingListStart");
      for (const entry of value.entries) {
        let name = `\\textbf{${escapeLatex(entry.name)}}`;
        if (entry.url) name = `\\href{${url(entry.url)}}{${name}}`;
        const left = entry.technologies ? `${name} $|$ \\emph{${escapeLatex(entry.technologies)}}` : name;
        out.push(`    \\resumeProjectHeading{${left}}{${escapeLatex(entry.dates ?? "")}}`, ...itemList(entry.bullets));
      }
      out.push("  \\resumeSubHeadingListEnd");
      break;
    case "skills":
      out.push(" \\begin{itemize}[leftmargin=0.15in, label={}]", "    \\small{\\item{");
      for (const group of value.groups) out.push(`     \\resumeSkillLine{${escapeLatex(group.label)}}{${group.items.map(escapeLatex).join(", ")}}`);
      out.push("    }}", " \\end{itemize}");
      break;
    case "list":
      out.push("  \\resumeSubHeadingListStart", "    \\item", ...itemList(value.items), "  \\resumeSubHeadingListEnd");
      break;
  }
  return out;
}

function contact(item: { text: string; url?: string | undefined }): string {
  return item.url ? `\\href{${url(item.url)}}{\\underline{${escapeLatex(item.text)}}}` : escapeLatex(item.text);
}

export function renderResumeBody(resume: ResumeDocument): string {
  const contacts = resume.heading.contacts.map(contact).join(" $|$ ");
  return [`\\resumeHeading{${escapeLatex(resume.heading.name)}}{${contacts}}`, "", ...resume.sections.flatMap(value => [...section(value), ""])].join("\n");
}

export function renderResume(template: string, resume: ResumeDocument): string {
  if (template.split(BODY_MARKER).length !== 2) throw new Error(`The resume template must contain exactly one ${BODY_MARKER} line`);
  return template.replace(BODY_MARKER, () => renderResumeBody(resume));
}

type Sender = Pick<Profile, "name" | "email" | "phone" | "location" | "links">;

function senderContacts(sender: Sender): string {
  return [
    ...(sender.phone ? [escapeLatex(sender.phone)] : []),
    `\\href{mailto:${url(sender.email)}}{\\underline{${escapeLatex(sender.email)}}}`,
    ...(sender.location ? [escapeLatex(sender.location)] : []),
    ...sender.links.map(link => contact({ text: link.label, url: link.url })),
  ].join(" $|$ ");
}

function fillMarkers(template: string, values: Record<string, string>, kind: string): string {
  if (!template.includes(BODY_MARKER)) throw new Error(`The ${kind} template must contain ${BODY_MARKER}`);
  return template.replace(/%%WAT:([A-Z_]+)%%/g, (marker, name: string) => values[name] ?? marker);
}

export function renderCoverLetter(template: string, letter: CoverLetter, sender: Sender): string {
  const recipient = [
    letter.recipient.name, letter.recipient.title, letter.recipient.company, ...letter.recipient.addressLines,
  ].filter((value): value is string => !!value).map(escapeLatex).join(" \\\\\n");
  const date = letter.date ?? new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const values: Record<string, string> = {
    SENDER_NAME: escapeLatex(sender.name),
    SENDER_CONTACT: senderContacts(sender),
    DATE: escapeLatex(date),
    RECIPIENT: recipient,
    GREETING: escapeLatex(letter.greeting),
    BODY: letter.paragraphs.map(inline).join("\n\n"),
    CLOSING: escapeLatex(letter.closing),
  };
  return fillMarkers(template, values, "cover letter");
}

export function renderJobDocument(template: string, document: JobDocument, sender: Sender): string {
  const body = document.sections.flatMap(section => [
    ...(section.heading ? [`\\docSection{${escapeLatex(section.heading)}}`] : []),
    ...section.paragraphs.map(paragraph => `${inline(paragraph)}\n`),
    ...(section.bullets.length ? ["\\docBulletsStart", ...section.bullets.map(item => `  \\item ${inline(item)}`), "\\docBulletsEnd"] : []),
    "",
  ]).join("\n");
  return fillMarkers(template, {
    SENDER_NAME: escapeLatex(sender.name),
    SENDER_CONTACT: senderContacts(sender),
    TITLE: escapeLatex(document.title),
    SUBTITLE: escapeLatex(document.subtitle ?? ""),
    BODY: body,
  }, "document");
}
