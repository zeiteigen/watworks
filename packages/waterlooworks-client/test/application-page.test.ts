import { describe, expect, test } from "bun:test";
import { parseApplicationPage } from "../src/application-page.js";

function slot(label = "*Résumé", typeId = "resume-type", extra = ""): string {
  return `<fieldset class="input__group"><legend><span>${label}</span><button>(Clear Selection)</button></legend>
    <label><input type="radio" class="customPkg" name="${typeId}" data-dt-id="${typeId}" value="document-one" ${extra}>
    <span class="label--span"><button>Preview</button><div>Sample document</div></span></label>
    <button class="js--btn--upload-new-doc" data-dt-id="${typeId}" data-dt-name="${label}"></button></fieldset>`;
}
function wizard(options: { slots?: string; questions?: string; controls?: string; script?: string } = {}): string {
  return `<html><body><form id="applyForm">
    <input type="hidden" name="\${name}" value="template-private">
    <input type="hidden" name="uiForm" value="fake-private-form">
    <input type="hidden" name="postingId" value="fake-posting">
    <input type="hidden" name="wizardMode" value="apply">
    <input type="hidden" name="wizardStateId" value="fake-private-state">
    <div id="applicationOptions"><fieldset class="input__group"><legend>Package</legend><input type="radio" name="applyOption" value="custom"></fieldset>
    <input id="packageName" name="name" value="Sample package">${options.slots ?? slot()}</div>
    <select name="selectExisting_resume-type"><option value="document-one">Sample document</option></select>
    ${options.questions === undefined ? "" : `<div id="preScreenQuestions">${options.questions}</div>`}${options.controls ?? ""}</form>
    <form id="fileUploadForm"><input type="hidden" name="action" value="fake-save-operation">
    <input type="hidden" name="postingId" value="fake-posting"><input type="hidden" name="docType" value="">
    <input type="hidden" name="uiForm" value="fake-upload-form"><input type="hidden" name="removeFile_docUpload" value="">
    <input type="hidden" name="docUploaded" value=""><input type="hidden" name="unexpected" value="never-copy">
    <input id="fileUploadAction_docUpload" type="hidden" value="fake-upload-operation"></form>
    <script>function validateApplicationOptions(){ const request = {action: 'fake-submit-operation'}; }
    orbisAppSr.ajax['confirmStepAjax'] = { params: {'postingId': 123, 'action': 'fake-confirm-operation'}, load: function(){ throw new Error('never execute'); } };
    orbisFileUpload.init('docUpload', '', '', 'pdf', 5000000, false);${options.script ?? ""}</script></body></html>`;
}

// Sanitized observed platform scaffold; operation token and form identifiers are fake.
const benignReloadScaffold = String.raw`
var keysToIgnore = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Insert", "CapsLock", "Control", "Alt", "Shift"];
$(function() {
$(document).on('change', '.df1234_ select.leader', function(){
var el = this;
var inputId = el.id;
var focused = el == document.activeElement;
reload_form1234(null, function(){
el = $("#" + inputId);
var selectedOption = $(el).children('option:selected')[0];
if (selectedOption.id && selectedOption.id.startsWith('dropdownOther_')) {
var $otherText = $("#o" + selectedOption.id.slice(9));
if (selectedOption.value == 'Other') {
selectedOption.value = '';
$otherText.val('');
}
$otherText.focus();
} else if (focused) {
$(el).focus();
}
});
});
$(document).on('keyup', '.df1234_ input.leader[type=text]', function(){
if(!keysToIgnore.includes(event.key))
{
var curVal = $(this).val();
var el = this;
window.setTimeout(function(){
if (el.value == curVal){
var inputId = el.id;
var focused = el == document.activeElement;
var selectionStart = focused ? el.selectionStart : null;
var selectionEnd = focused ? el.selectionEnd : null;
if (focused) {
reload_form1234(null, function(){
el = $("#" + inputId).focus()[0];
el.selectionStart = selectionStart;
el.selectionEnd = selectionEnd;
if (!curVal) {
el.value = '';
}
});
} else {
reload_form1234();
}
}
}, 1000);
}
});
$(document).on('click', '.df1234_ input.leader[type=radio]', function(){reload_form1234()});
$(document).on('click', '.df1234_ input.leader[type=checkbox]', function(){reload_form1234()});
$(document).on('groupChanged', '.df1234_ .toggle-group.leader', function(){reload_form1234()});
});
$(window).on("load", function(){
var $form = $('[id^=question_]').closest('form');
$form.trigger("dfFormLoadStop");
});
function reload_form1234(resetForEmptyString, callback) {
var $form = $('[id^=question_]').closest('form');
$form.trigger("dfFormLoadStart");
var request = $form.serializeFormToObject();
request.action = 'fake-reload-operation';
request.modelId = '1234';
request.confirmationCode = '';
request.recordId = '';
request.resetForEmptyString = resetForEmptyString;
request.key = '';
request.showDFForm2 = '';
request.showDFForm3 = '';
request.dfRenderInBox = '';
request.dfShowCategories = 'true';
request.showQuestionCheckboxes = false;
request.forceSpiralRobot = 'true';
for(key in request) {
if(key.startsWith('dfh_')) {
request[key.replace('dfh_', '')] = request[key];
delete request[key];
}
}
if (!callback) {
callback = function() {};
}
// 			$('.df1234_').empty();
$('.df1234_').load('/myAccount/co-op/full/jobs.htm', request, function(){
$form.trigger("dfFormLoadStop");
callback.apply(this, arguments);
});
}
`;

describe("application wizard parser", () => {
  test("extracts documents and keeps transport fields separate from public schema", () => {
    const parsed = parseApplicationPage(wizard());
    expect(parsed.blockers).toEqual([]);
    expect(parsed.requirements).toEqual([{ id: "resume-type", typeId: "resume-type", label: "Résumé", role: "resume", required: true }]);
    expect(parsed.documents).toEqual([{ id: "document-one", typeId: "resume-type", name: "Sample document", revision: "pending", state: "unknown", source: "library" }]);
    expect(parsed.privateFields).toEqual({ uiForm: "fake-private-form", postingId: "fake-posting", wizardMode: "apply", wizardStateId: "fake-private-state" });
    expect(parsed.uploadSaveFields).toEqual({ action: "fake-save-operation", postingId: "fake-posting", docType: "", uiForm: "fake-upload-form", removeFile_docUpload: "", docUploaded: "" });
    expect(parsed.submitAction).toBe("fake-submit-operation");
    expect(parsed.confirmationAction).toBe("fake-confirm-operation");
    expect(parsed.uploadAction).toBe("fake-upload-operation");
    expect(parsed.uploadDirectory).toBe("");
    expect(parsed.packageName).toBe("Sample package");
    expect(JSON.stringify({ requirements: parsed.requirements, questions: parsed.questions })).not.toContain("fake-private");
  });

  test("inventories disabled existing documents and honors uppercase checked attributes", () => {
    const parsed = parseApplicationPage(wizard({ slots: slot("*Resume", "resume-type", 'disabled class="js--non-default-doc"') + slot("*Grade Report", "grade-type", "CHECKED").replace(/<button class="js--btn--upload-new-doc"[^>]*><\/button>/g, "") }));
    expect(parsed.documents).toHaveLength(2);
    const grade = parsed.requirements.find(requirement => requirement.role === "system")!;
    expect(grade.selectedDocument?.source).toBe("system");
    expect(parsed.blockers).toEqual([]);
  });

  test("does not invent a selection for required system documents", () => {
    const parsed = parseApplicationPage(wizard({ slots: slot() + slot("*Grade Report", "grade-type") }));
    expect(parsed.requirements[1]?.selectedDocument).toBeUndefined();
    expect(parsed.blockers).toContain("A required system document is unavailable or ambiguous.");
  });

  test("supports empty attachment slots with explicit upload type metadata", () => {
    const parsed = parseApplicationPage(wizard({ slots: slot() + '<fieldset class="input__group"><legend><span>*Portfolio</span></legend><button class="js--btn--upload-new-doc" data-dt-id="portfolio-type"></button></fieldset>' }));
    expect(parsed.requirements[1]).toMatchObject({ id: "portfolio-type", role: "attachment", required: true });
    expect(parsed.blockers).toEqual([]);
  });

  test("recognizes explicit wire names, choice values and ordinary constraints", () => {
    const parsed = parseApplicationPage(wizard({ questions: `<label for="why">Why apply?</label><textarea id="why" name="q_text" required maxlength="120"></textarea>
      <label for="years">Years</label><input id="years" name="q_years" type="number" min="0" max="10">
      <fieldset><legend>Location</legend><label><input type="radio" name="q_location" value="remote" required>Remote</label><label><input type="radio" name="q_location" value="office">Office</label></fieldset>
      <fieldset><legend>Skills</legend><label><input type="checkbox" name="q_skills" value="ts">TypeScript</label><label><input type="checkbox" name="q_skills" value="py">Python</label></fieldset>
      <label><input type="checkbox" name="q_consent" value="accepted" required>I agree</label>
      <label for="term">Term</label><select id="term" name="q_term"><option value="">Choose</option><option value="winter">Winter</option></select>` }));
    expect(parsed.blockers).toEqual([]);
    expect(parsed.questions).toEqual([
      { id: "q_text", label: "Why apply?", type: "text", required: true, maxLength: 120 },
      { id: "q_years", label: "Years", type: "number", required: false, integer: true, min: 0, max: 10 },
      { id: "q_location", label: "Location", type: "single_choice", required: true, options: [{ id: "remote", label: "Remote" }, { id: "office", label: "Office" }] },
      { id: "q_skills", label: "Skills", type: "multiple_choice", required: false, options: [{ id: "ts", label: "TypeScript" }, { id: "py", label: "Python" }] },
      { id: "q_consent", label: "I agree", type: "boolean", required: true, mustBeTrue: true, options: [{ id: "accepted", label: "I agree" }] },
      { id: "q_term", label: "Term", type: "single_choice", required: false, options: [{ id: "winter", label: "Winter" }] },
    ]);
  });

  test("blocks individual required checkbox constraints and unusual number step bases", () => {
    for (const questions of [
      '<fieldset><legend>Checks</legend><label><input type="checkbox" name="checks" value="a" required>A</label><label><input type="checkbox" name="checks" value="b">B</label></fieldset>',
      '<label>Quantity<input type="number" name="quantity" value="0.5"></label>',
    ]) expect(parseApplicationPage(wizard({ questions })).blockers.length).toBeGreaterThan(0);
  });

  test("parses observed static pre-screen select with inert wizard metadata and private hidden fields", () => {
    const questions = `<input type="hidden" name="isSpiralRobot" value="true">
      <div class="df1234_ dfForm"><div class="js--question--container"><label class="label">Can you commit to the full term?*</label>
      <select id="question_static_" name="question_static" class="js--ui-select required" onchange="">
      <option class="emptyOption" value="">Select</option><option value="yes-value">Yes</option><option value="no-value">No</option></select>
      <script>$('#question_static_').uiSelect({});</script></div></div>
      <script>$(".js--category--container").each(function(){
        if($(this).find(".js--question--container").length == 0)
        {
          $(this).remove();
        }
      });</script><script>${benignReloadScaffold}</script>`;
    const html = wizard({ questions }).replace('<div id="preScreenQuestions">', '<div id="preScreenQuestions" data-additional-step-validation="validatePreScreenQuestions()" data-display-condition="" data-allow-skip="false" data-status="incomplete" data-ajax="">');
    const parsed = parseApplicationPage(html);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.privateFields.isSpiralRobot).toBe("true");
    expect(parseApplicationPage(html.replace('name="isSpiralRobot" value="true"', 'name="isSpiralRobot" value="false"')).blockers).toContain("Application wizard contains an unsupported named control.");
    expect(parseApplicationPage(html.replace('name="isSpiralRobot"', 'name="unknownServerState"')).blockers).toContain("Application wizard contains an unsupported named control.");
    expect(parsed.questions).toEqual([{ id: "question_static", label: "Can you commit to the full term?*", type: "single_choice", required: true, options: [{ id: "yes-value", label: "Yes" }, { id: "no-value", label: "No" }] }]);
    expect(JSON.stringify(parsed.questions)).not.toContain("isSpiralRobot");
    expect(parseApplicationPage(html.replace('data-display-condition=""', 'data-display-condition="question_other=yes"')).blockers).toContain("Pre-screening questions contain unsupported dynamic behavior.");
    expect(parseApplicationPage(html.replace('class="js--ui-select required"', 'class="js--ui-select required leader"')).blockers).toContain("Pre-screening questions contain unsupported dynamic behavior.");
    expect(parseApplicationPage(html.replace(benignReloadScaffold, benignReloadScaffold + "\nwindow.doSomethingUnknown();")).blockers).toContain("Pre-screening questions contain unsupported dynamic behavior.");
  });

  test("accepts the empty inert platform scaffold but rejects hidden unknown questions", () => {
    const questions = `<input type="hidden" name="isSpiralRobot" value="true"><div class="df1234_ dfForm"><script>${benignReloadScaffold}</script></div>`;
    expect(parseApplicationPage(wizard({ questions })).blockers).toEqual([]);
    expect(parseApplicationPage(wizard({ questions: questions.replace('</div>', '<div class="js--question--container">Unreadable question</div></div>') })).blockers.length).toBeGreaterThan(0);
    expect(parseApplicationPage(wizard({ questions: questions.replace(benignReloadScaffold, 'unknownScript();') })).blockers.length).toBeGreaterThan(0);
  });

  test("keeps optional single checkboxes as boolean questions", () => {
    const parsed = parseApplicationPage(wizard({ questions: '<label><input type="checkbox" name="q_updates" value="enabled">Send updates</label>' }));
    expect(parsed.blockers).toEqual([]);
    expect(parsed.questions[0]).toEqual({ id: "q_updates", label: "Send updates", type: "boolean", required: false, options: [{ id: "enabled", label: "Send updates" }] });
  });

  test("blocks dynamic and unsupported pre-screening questions", () => {
    for (const questions of ["", '<input type="file" name="essay" aria-label="Essay">', '<label data-condition="q_1=yes">Question<input name="q_2"></label>', '<label>Age<input name="age" type="number" step="0.5"></label>', '<script>throw new Error("never execute")</script>']) {
      expect(parseApplicationPage(wizard({ questions })).blockers.length).toBeGreaterThan(0);
    }
  });

  test("blocks unknown named fields, duplicate private fields and ambiguous resume slots", () => {
    expect(parseApplicationPage(wizard({ controls: '<input name="unknown" value="some">' })).blockers).toContain("Application wizard contains an unsupported named control.");
    expect(parseApplicationPage(wizard({ controls: '<input type="hidden" name="uiForm" value="duplicate">' })).blockers).toContain("Application wizard has duplicate private fields.");
    expect(parseApplicationPage(wizard({ slots: slot() + slot("Resume", "second-type") })).blockers).toContain("Application must have exactly one understood resume requirement.");
  });

  test("never executes configuration expressions or accepts missing contracts", () => {
    expect(() => parseApplicationPage(wizard().replace("'fake-confirm-operation'", "(() => 'fake-confirm-operation')()"))).toThrow();
    expect(() => parseApplicationPage(wizard().replace("orbisFileUpload.init", "unknown.init"))).toThrow();
    expect(() => parseApplicationPage("<form></form>")).toThrow();
  });
});
