import { expect, test } from "bun:test";
import { parseApplicationPage } from "../src/application-page.js";
import { applicationWizard } from "./application-fixtures.js";

// Pre-screening section captured from posting 495835 with the reload operation masked.
const screening = await Bun.file(new URL("./fixtures/screening-select-other.html", import.meta.url)).text();
function parse(markup = screening) {
  return parseApplicationPage(applicationWizard(false, false).replace("</form>", markup + "</form>"));
}

test("posting 495835 supports predefined dropdown answers while excluding the Other option and textbox", () => {
  const parsed = parse();
  expect(parsed.blockers).toEqual([]);
  expect(parsed.questions).toEqual([
    { id: "question_111489", label: "Have you worked with large data sets in the past?*", type: "single_choice", required: true, options: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }] },
    { id: "question_111490", label: "Do you foresee any issues with obtaining security clearance if needed? (See Responsibilities Section for further details).*", type: "multiple_choice", required: true, options: [
      { id: "No - I can provide financial, background/birth certificates, and criminal checks as needed.", label: "No - I can provide financial, background/birth certificates, and criminal checks as needed." },
      { id: "Yes - I cannot provide the needed documentation or foresee issues.", label: "Yes - I cannot provide the needed documentation or foresee issues." },
      { id: "Unsure", label: "Unsure" },
    ] },
  ]);
});

test("supports different generated question IDs and static choice text", () => {
  const parsed = parse(screening.replaceAll("111489", "98765").replaceAll('"Yes","No"', '"Remote","Office"')
    .replace(/value="Yes"\s*>\s*Yes/, 'value="Remote">Remote').replace(/value="No"\s*>\s*No/, 'value="Office">Office'));
  expect(parsed.blockers).toEqual([]);
  expect(parsed.questions[0]).toMatchObject({ id: "question_98765", type: "single_choice", required: true, options: [{ id: "Remote", label: "Remote" }, { id: "Office", label: "Office" }] });
});

test.each([
  ["changed widget behavior", (html: string) => html.replace("choices.forEach(splitter);", "choices.forEach(splitter); unknownOperation();")],
  ["choices differing from options", (html: string) => html.replace('var choices = ["Yes","No"];', 'var choices = ["Yes","Maybe"];')],
  ["choices with a split marker", (html: string) => html.replace('var choices = ["Yes","No"];', 'var choices = ["Yes|1","No"];')],
  ["a selected Other option", (html: string) => html.replace('id="dropdownOther_111489_"', 'id="dropdownOther_111489_" selected')],
  ["a saved Other value", (html: string) => html.replace('id="other_111489_" value=""', 'id="other_111489_" value="A previous answer"')],
  ["a saved Other option value", (html: string) => html.replace(/(id="dropdownOther_111489_"[\s\S]*?)value=""/, '$1value="A previous answer"')],
  ["a visible Other textbox", (html: string) => html.replace('class="input__group margin--b--xxxl display--none"', 'class="input__group margin--b--xxxl"')],
  ["a required Other textbox", (html: string) => html.replace('id="other_111489_"', 'id="other_111489_" required')],
  ["a changed length rule", (html: string) => html.replace('data-rule-maxlength="255"', 'data-rule-maxlength="10"')],
  ["other data attributes on the textbox", (html: string) => html.replace('id="other_111489_"', 'id="other_111489_" data-condition="x"')],
  ["an Other textbox event handler", (html: string) => html.replace('onkeydown=""', 'onkeydown="reload()"')],
  ["conditional reloads", (html: string) => html.replace('class="js--ui-select sel_TestValidationStatus', 'class="leader js--ui-select sel_TestValidationStatus')],
  ["a multiple-selection dropdown", (html: string) => html.replace('name="question_111489"', 'name="question_111489" multiple')],
] as const)("keeps %s blocked", (_label, change) => {
  const changed = change(screening);
  expect(changed).not.toBe(screening);
  expect(parse(changed).blockers.length).toBeGreaterThan(0);
});
