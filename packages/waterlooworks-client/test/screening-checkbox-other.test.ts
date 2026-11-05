import { expect, test } from "bun:test";
import { parseApplicationPage } from "../src/application-page.js";
import { applicationWizard } from "./application-fixtures.js";

// DOM captured from posting 494936; contains only the two public questions.
const screening = await Bun.file(new URL("./fixtures/screening-checkboxes-other.html", import.meta.url)).text();
function parse(markup = screening) {
  return parseApplicationPage(applicationWizard(false, false).replace("</form>", `<div id="preScreenQuestions">${markup}</div></form>`));
}

test("posting 494936 supports predefined answers while excluding Other and All controls", () => {
  const parsed = parse();
  expect(parsed.blockers).toEqual([]);
  expect(parsed.questions).toEqual([
    { id: "question_111383", label: "This job requires that you work in-person in Wallenstein, ON. *", type: "multiple_choice", required: true, options: [{ id: "I am able to work in person.", label: "I am able to work in person." }, { id: "I am unable to work in person.", label: "I am unable to work in person." }] },
    { id: "question_111384", label: "This position is funded through the Government of Canada's Student Work Placement Program (SWPP). Do you meet the requirements to participate in this program?*", type: "multiple_choice", required: true, options: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }] },
  ]);
});

test.each([
  ["changed widget behavior", (html: string) => html.replace("var limitAnswer = 0;", "var limitAnswer = 1;")],
  ["selected Other toggle", (html: string) => html.replace('type="checkbox" id="otherCheckbox_111383_"', 'type="checkbox" checked id="otherCheckbox_111383_"')],
  ["saved Other text", (html: string) => html.replace('checked="false" value=""', 'checked="false" value="A previous answer"')],
  ["named Other toggle", (html: string) => html.replace('type="checkbox" id="otherCheckbox_111383_"', 'type="checkbox" name="unexpected" id="otherCheckbox_111383_"')],
  ["required Other text", (html: string) => html.replace('placeholder="Other Value"', 'required placeholder="Other Value"')],
  ["unrelated unnamed input", (html: string) => html + '<input type="checkbox">'],
  ["dynamic attributes", (html: string) => html.replace('name="other_111383"', 'name="other_111383" data-condition="x"')],
  ["missing Other textbox", (html: string) => html.replace(/<input type="text"[^>]*>/, '')],
] as const)("keeps %s blocked", (_label, change) => {
  expect(parse(change(screening)).blockers.length).toBeGreaterThan(0);
});
