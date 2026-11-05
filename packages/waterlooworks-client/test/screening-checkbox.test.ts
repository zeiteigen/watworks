import { expect, test } from "bun:test";
import { parseApplicationPage } from "../src/application-page.js";
import { applicationWizard } from "./application-fixtures.js";

const screening = await Bun.file(new URL("./fixtures/screening-checkboxes.html", import.meta.url)).text();
function parse(markup = screening) {
  return parseApplicationPage(applicationWizard(false, false).replace("</form>", markup + "</form>"));
}

test("parses posting 495378's required checkbox groups without treating All as an answer", () => {
  const parsed = parse();
  expect(parsed.blockers).toEqual([]);
  expect(parsed.questions).toEqual([
    { id: "question_111368", label: "Have you been involved in quantitative/ qualitative research data collection or analysis (e.g., survey, observational studies, focus groups or semi-structured interviews)?*", type: "multiple_choice", required: true, options: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }] },
    { id: "question_111369", label: "Do you have experience working with REDCap?*", type: "multiple_choice", required: true, options: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }] },
  ]);
});

test("supports different generated question IDs and static choice text", () => {
  const parsed = parse(screening.replaceAll("111368", "98765").replaceAll("Yes", "Remote").replaceAll("No", "Office"));
  expect(parsed.blockers).toEqual([]);
  expect(parsed.questions[0]).toMatchObject({ id: "question_98765", required: true, options: [{ id: "Remote", label: "Remote" }, { id: "Office", label: "Office" }] });
});

test.each([
  ["a selection limit", (html: string) => html.replace("var limitAnswer = 0", "var limitAnswer = 1")],
  ["saved selections", (html: string) => html.replace("var selectedChoices = []", 'var selectedChoices = ["Yes"]')],
  ["changed executable behavior", (html: string) => html.replace("var limitAnswer = 0;", "var limitAnswer = 0; unknownOperation();")],
  ["conditional reloads", (html: string) => html.replace('class="question_111368_"', 'class="question_111368_ leader"')],
  ["Other text fields", (html: string) => html.replace('<input type="checkbox" class="" name="">', '<input name="other_111368" type="text">')],
  ["a named select-all toggle", (html: string) => html.replace('name=""', 'name="select_all"')],
  ["choices differing from script configuration", (html: string) => html.replace('value="Yes"', 'value="Different"')],
  ["unknown widget validation", (html: string) => html.replace("'required':true", "'required':true, 'unknown':true")],
  ["unknown data attributes", (html: string) => html.replace('class="question_111368_"', 'class="question_111368_" data-condition="other=yes"')],
] as const)("keeps %s blocked", (_label, change) => {
  expect(parse(change(screening)).blockers).toContain("Pre-screening questions contain unsupported dynamic behavior.");
});

test("does not ignore unrelated unnamed inputs", () => {
  const parsed = parse(screening.replace('</legend>', '</legend><input type="checkbox" name="">'));
  expect(parsed.blockers).toContain("A pre-screening control has no supported field name.");
});
