import { expect, test } from "bun:test";
import { applyResumeChanges, changeLocation, resumeLines, reviewUnits, wordDiff, type ResumeChange } from "./resume-changes.js";
import type { ResumeDocument } from "../../workspace/src/schemas.js";

const base: ResumeDocument = {
  heading: { name: "Ada Student", contacts: [{ text: "ada@example.test" }] },
  sections: [
    { kind: "experience", title: "Experience", entries: [
      { role: "Developer", organization: "Acme", bullets: ["Built Python integrations for client databases", "Wrote documentation"] },
      { role: "Tutor", organization: "School", bullets: ["Taught math"] },
    ] },
    { kind: "projects", title: "Projects", entries: [{ name: "Fraise", technologies: "Python, PyTorch", bullets: ["Trained a 75M-parameter model"] }] },
    { kind: "skills", title: "Technical Skills", groups: [{ label: "Languages", items: ["Python", "TypeScript", "Rust"] }] },
  ],
};
const changes: ResumeChange[] = [
  { id: "c0", kind: "rewrite", target: "s0.e0.b0", before: "Built Python integrations for client databases", after: "Built Python and SQL integrations for client CRM databases" },
  { id: "c1", kind: "remove", target: "s0.e1", before: "Tutor, School" },
  { id: "c2", kind: "add", container: "s0.e0", before: "s0.e0.b1", text: "Cut load time by 50%" },
  { id: "c3", kind: "rewrite", target: "s2.g0", before: "Python, TypeScript, Rust", after: "Python, SQL, TypeScript" },
];

test("resume lines give every editable line a stable id", () => {
  expect(resumeLines(base).map(line => line.id)).toEqual(["s0.e0", "s0.e0.b0", "s0.e0.b1", "s0.e1", "s0.e1.b0", "s1.e0", "s1.e0.t", "s1.e0.b0", "s2.g0"]);
  expect(changeLocation(base, changes[1]!)).toBe("Experience · Tutor, School");
  expect(changeLocation(base, changes[2]!)).toBe("Experience · Developer, Acme");
});

test("accepting nothing returns the base and accepting everything applies each change", () => {
  expect(applyResumeChanges(base, changes, [])).toEqual(base);
  const all = applyResumeChanges(base, changes, ["c0", "c1", "c2", "c3"]);
  expect(all.sections[0]).toMatchObject({ entries: [{ bullets: ["Built Python and SQL integrations for client CRM databases", "Cut load time by 50%", "Wrote documentation"] }] });
  expect(all.sections[2]).toMatchObject({ groups: [{ items: ["Python", "SQL", "TypeScript"] }] });
});

test("word hunks can be accepted one at a time", () => {
  const segments = wordDiff("c0", changes[0]!.before as string, (changes[0] as { after: string }).after);
  expect(segments.filter(segment => "id" in segment)).toEqual([
    { id: "c0.w0", before: "", after: "and SQL " },
    { id: "c0.w1", before: "", after: "CRM " },
  ]);
  expect(segments.map(segment => "same" in segment ? segment.same : segment.after).join("")).toBe("Built Python and SQL integrations for client CRM databases");
  const partial = applyResumeChanges(base, changes, ["c0.w1"]);
  expect(partial.sections[0]).toMatchObject({ entries: [{ bullets: ["Built Python integrations for client CRM databases", "Wrote documentation"] }, { role: "Tutor" }] });
  expect(reviewUnits(changes, "word")).toEqual(["c0.w0", "c0.w1", "c1", "c2", "c3.w0"]);
  expect(reviewUnits(changes, "line")).toEqual(["c0", "c1", "c2", "c3"]);
});

test("adjacent replaced words form one hunk", () => {
  const hunks = wordDiff("c", "Wrote fast reliable tools", "Designed quick reliable tools").filter(segment => "id" in segment);
  expect(hunks).toEqual([{ id: "c.w0", before: "Wrote fast", after: "Designed quick" }]);
});

test("removing every entry of a section drops the section", () => {
  const result = applyResumeChanges(base, [{ id: "r", kind: "remove", target: "s1.e0", before: "Fraise" }], ["r"]);
  expect(result.sections.map(section => section.title)).toEqual(["Experience", "Technical Skills"]);
});
