import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import type { PreparedFile } from "../../application-workflow/src/types.js";
import { createStaticSession } from "../src/session.js";

export const applicationSession = createStaticSession([{ name: "WW_SESSION", value: "fake-test-session", domain: "waterlooworks.uwaterloo.ca", path: "/", secure: true, httpOnly: true }]);
async function syntheticPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(); pdf.addPage().drawText(text); return pdf.save();
}
export const applicationPdf = await syntheticPdf("Synthetic resume and transcript");
export const attachmentPdf = await syntheticPdf("Synthetic attachment");
export const pdfHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const preparedAttachment: PreparedFile = { filename: "portfolio.pdf", size: attachmentPdf.length, sha256: pdfHash(attachmentPdf), bytes: attachmentPdf };

export const documentsPage = `<a onclick="buildForm({action:'fake-upload-entry',ownerId:'1234'})">Upload A Document</a>
  <a onclick="buildForm({action:'fake-docOwnerStats',docTypeId:'67'})">Resume</a>
  <script>orbisApp.docPreview.getDocument = function(){const request={action:'fake-preview'};};</script>`;
export const inventoryPage = `<script>var doc_commonTable_additionalParams = {docTypeId:'67'};
  function doc_commonTable(page){ const request={action:'fake-grid',gridInstanceId:'fake-instance',modId:'fake-module'}; }</script>`;
export const inventoryRow = `<table><tr><td><input class="ms_check" id="doc_commonTable_record100"></td>
  <td><button data-doc-id="100">Preview</button></td><td>Sample Resume</td><td>Resume</td><td>Oct 1, 2026</td><td>Yes</td><td>No</td></tr></table>`;

function documentSlot(label: string, type: string, id?: string): string {
  return `<fieldset class="input__group"><legend><span>*${label}</span></legend>${id ? `<label><input type="radio" class="customPkg" name="${type}" data-dt-id="${type}" value="${id}" CHECKED><span class="label--span"><div>${label === "Résumé" ? "Sample Resume" : "Sample Transcript"}</div></span></label>` : ""}${type !== "71" ? `<button type="button" class="js--btn--upload-new-doc" data-dt-id="${type}"></button>` : ""}</fieldset>`;
}

export function applicationWizard(screening: boolean, attachment: boolean): string {
  return `<form id="applyForm"><input type="hidden" name="uiForm" value="true"><input type="hidden" name="postingId" value="12345">
    <input type="hidden" name="wizardMode" value="true"><input type="hidden" name="wizardStateId" value="fake-wizard-state">
    <div id="applicationOptions"><input id="packageName" name="name" value="Sample Package">
    ${documentSlot("Résumé", "67", "100")}${documentSlot("Grade Report", "71", "300")}${attachment ? documentSlot("Portfolio", "70") : ""}</div>
    ${screening ? `<div id="preScreenQuestions" data-additional-step-validation="validatePreScreenQuestions()" data-display-condition="" data-allow-skip="false" data-status="incomplete" data-ajax="">
    <input type="hidden" name="isSpiralRobot" value="true"><div class="js--question--container"><label class="label">Available for the term?</label>
    <select id="q_term" name="question_term" required><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select>
    <script>$('#q_term').uiSelect({});</script></div>
    <label><input type="checkbox" name="question_updates" value="send">Send updates</label>
    <fieldset><legend>Skills</legend><label><input type="checkbox" name="question_skills" value="ts">TypeScript</label><label><input type="checkbox" name="question_skills" value="py">Python</label></fieldset></div>` : ""}</form>
    <form id="fileUploadForm"><input type="hidden" name="action" value="fake-save-attachment"><input type="hidden" name="postingId" value="12345">
    <input type="hidden" name="docType" value=""><input type="hidden" name="uiForm" value="true"><input type="hidden" name="removeFile_docUpload" value=""><input type="hidden" name="docUploaded" value="">
    <input id="fileUploadAction_docUpload" type="hidden" value="fake-stage-attachment"><input type="checkbox" name="defaultDoc" value="true"></form>
    <script>function validateApplicationOptions(){const request={action:'fake-commit'};}
    orbisAppSr.ajax['confirmStepAjax']={params:{action:'fake-confirm'}};
    orbisFileUpload.init('docUpload','','','pdf',5000000,false);</script>`;
}

export function applicationOverview(method = "WaterlooWorks"): string {
  return `<table><tr><td>Application Method:</td><td>${method}</td></tr><tr><td>Additional Application Information:</td><td>Complete the optional employer survey.</td></tr></table>`;
}
