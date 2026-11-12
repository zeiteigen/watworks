import { describe, expect, test } from "bun:test";
import { escapeLatex, inline, renderCoverLetter, renderJobDocument, renderResume, renderResumeBody } from "./render.js";
import { JobDocumentSchema, ResumeDocumentSchema } from "../schemas.js";

const profile = {
  name: "Jane Doe", email: "jane@example.com", links: [{ label: "github.com/jane", url: "https://github.com/jane" }],
  workAuthorization: { canada: "citizen", unitedStates: "none", needsSponsorship: { canada: false, unitedStates: true } },
  targets: [{ id: "backend", label: "Backend", keywords: ["backend"], resumeVariant: "swe" }],
};

const resume = {
  heading: { name: "Jane Doe", contacts: [{ text: "jane@example.com", url: "mailto:jane@example.com" }] },
  sections: [
    { kind: "experience", entries: [{ role: "Developer", organization: "Acme & Co", dates: "2025", bullets: ["Cut latency **40%** with C# & $caching_"] }] },
    { kind: "skills", groups: [{ label: "Languages", items: ["C++", "TypeScript"] }] },
  ],
};

describe("LaTeX rendering", () => {
  test("escapes every special character so text cannot inject commands", () => {
    expect(escapeLatex("\\input{/etc/passwd} 100% & $x_1$ #1 ~^<>")).toBe("\\textbackslash{}input\\{/etc/passwd\\} 100\\% \\& \\$x\\_1\\$ \\#1 \\textasciitilde{}\\textasciicircum{}\\textless{}\\textgreater{}");
    expect(inline("a **b_c** d")).toBe("a \\textbf{b\\_c} d");
  });

  test("links cannot reopen TeX through caret notation, braces, or backslashes", () => {
    const render = (url: string) => renderResumeBody(ResumeDocumentSchema.parse({ heading: { name: "N", contacts: [{ text: "site", url }] }, sections: [{ kind: "list", title: "S", items: ["i"] }] }));
    const body = render("https://x.example/^^7d^^7bL^^7d^^5cinput^^7b/etc/passwd^^7d");
    expect(body).not.toContain("^");
    expect(body).toContain("https://x.example/\\%5E\\%5E7d");
    expect(render("https://x.example/a}\\input{b} c")).toContain("https://x.example/a\\%7D\\%5Cinput\\%7Bb\\%7D\\%20c}");
    expect(render("https://x.example/a%20b#c")).toContain("https://x.example/a\\%20b\\#c}");
    expect(render("github.com/jane")).toContain("\\href{github.com/jane}");
    expect(render("tel:+15551234")).toContain("\\href{tel:+15551234}");
    expect(() => render("file:///etc/passwd")).toThrow("Unsupported link scheme");
    expect(() => render("javascript:alert(1)")).toThrow("Unsupported link scheme");
  });

  test("profile links get the same protection", () => {
    const body = renderCoverLetter("%%WAT:SENDER_CONTACT%% %%WAT:BODY%%", { recipient: { company: "C", addressLines: [] }, greeting: "Hi", paragraphs: ["P"], closing: "Bye" }, { name: "N", email: "n@example.com", links: [{ label: "site", url: "https://x.example/^^5cinput" }] });
    expect(body).not.toContain("^");
  });

  test("renders resume sections with Jake's macros", () => {
    const body = renderResumeBody(ResumeDocumentSchema.parse(resume));
    expect(body).toContain("\\resumeHeading{Jane Doe}{\\href{mailto:jane@example.com}{\\underline{jane@example.com}}}");
    expect(body).toContain("\\resumeSubheading{Developer}{2025}{Acme \\& Co}{}");
    expect(body).toContain("\\resumeItem{Cut latency \\textbf{40\\%} with C\\# \\& \\$caching\\_}");
    expect(body).toContain("\\resumeSkillLine{Languages}{C++, TypeScript}");
  });

  test("requires exactly one body marker", () => {
    expect(() => renderResume("no marker", ResumeDocumentSchema.parse(resume))).toThrow("%%WAT:BODY%%");
    expect(renderResume("pre\n%%WAT:BODY%%\npost", ResumeDocumentSchema.parse(resume))).toStartWith("pre\n\\resumeHeading");
  });

  test("fills cover letter markers with escaped values", () => {
    const tex = renderCoverLetter("%%WAT:SENDER_NAME%%|%%WAT:RECIPIENT%%|%%WAT:BODY%%|%%WAT:UNKNOWN%%", {
      date: "Jan 1", recipient: { company: "R&D Inc", addressLines: ["1 Main St"] }, greeting: "Hi,", paragraphs: ["One.", "Two **x**."], closing: "Thanks,",
    }, profile as never);
    expect(tex).toBe("Jane Doe|R\\&D Inc \\\\\n1 Main St|One.\n\nTwo \\textbf{x}.|%%WAT:UNKNOWN%%");
  });
});

describe("job documents", () => {
  test("render sections with escaped paragraphs and bullets", () => {
    const doc = JobDocumentSchema.parse({ title: "Project Summary", sections: [{ heading: "R&D", paragraphs: ["Built **fast** things."], bullets: ["50% faster"] }] });
    const tex = renderJobDocument("%%WAT:TITLE%%|%%WAT:SUBTITLE%%|%%WAT:BODY%%", doc, profile as never);
    expect(tex).toBe("Project Summary||\\docSection{R\\&D}\nBuilt \\textbf{fast} things.\n\n\\docBulletsStart\n  \\item 50\\% faster\n\\docBulletsEnd\n");
    expect(() => JobDocumentSchema.parse({ title: "Empty", sections: [{ heading: "Nothing" }] })).toThrow("paragraphs or bullets");
  });
});
