import { sha256 } from "../../shared/src/sha256.js";
import { parseHTML } from "linkedom";
import type { ApplicationQuestion, DocumentRequirement, LibraryDocument } from "../../application-workflow/src/types.js";
import { discoverPageAction, parsePageLiteral } from "./bootstrap.js";
import { ProtocolChangedError } from "./errors.js";
import { screeningCheckboxWidgets } from "./screening-checkbox.js";
import { screeningSelectOtherWidgets } from "./screening-select-other.js";

export interface ParsedApplicationPage {
  requirements: DocumentRequirement[];
  documents: LibraryDocument[];
  questions: ApplicationQuestion[];
  blockers: string[];
  privateFields: Record<string, string>;
  submitAction: string;
  confirmationAction: string;
  uploadAction: string;
  uploadSaveFields: Record<string, string>;
  uploadDirectory: string;
  uploadMaxBytes: number;
  packageName: string;
}

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
const value = (element: Element): string => element.getAttribute("value") ?? "";
const name = (element: Element): string => element.getAttribute("name") ?? "";
const required = (element: Element): boolean => element.hasAttribute("required") || element.classList.contains("required") || element.getAttribute("aria-required") === "true";
const active = (element: Element): boolean => !element.hasAttribute("disabled") && !element.closest("fieldset[disabled],template");

/** Extract a balanced literal without evaluating any page code. */
function literalAt(source: string, start: number, open = "{", close = "}"): string {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === "'" || character === '"') quote = character;
    else if (character === open) depth++;
    else if (character === close && --depth === 0) return source.slice(start, index + 1);
  }
  throw new ProtocolChangedError("Incomplete application page configuration");
}

function confirmationAction(source: string): string {
  const assignment = /orbisAppSr\.ajax\[['"]confirmStepAjax['"]\]\s*=\s*\{/.exec(source);
  if (!assignment) throw new ProtocolChangedError("Missing application confirmation configuration");
  const body = literalAt(source, assignment.index + assignment[0].lastIndexOf("{"));
  const params = /\bparams\s*:\s*\{/.exec(body);
  if (!params) throw new ProtocolChangedError("Missing application confirmation parameters");
  const parsed = parsePageLiteral(literalAt(body, params.index + params[0].lastIndexOf("{")));
  const action = parsed && typeof parsed === "object" && "action" in parsed ? parsed.action : undefined;
  if (typeof action !== "string" || !action) throw new ProtocolChangedError("Missing application confirmation operation");
  return action;
}

function uploadConfiguration(source: string): { uploadDirectory: string; uploadMaxBytes: number } {
  const call = /orbisFileUpload\.init\s*\(/.exec(source);
  if (!call) throw new ProtocolChangedError("Missing application upload configuration");
  const args = literalAt(source, call.index + call[0].lastIndexOf("("), "(", ")");
  const parsed = parsePageLiteral(`[${args.slice(1, -1)}]`);
  if (!Array.isArray(parsed) || parsed[0] !== "docUpload" || typeof parsed[1] !== "string" || parsed[3] !== "pdf" || typeof parsed[4] !== "number" || !Number.isSafeInteger(parsed[4]) || parsed[4] <= 0) throw new ProtocolChangedError("Unsupported application upload configuration");
  return { uploadDirectory: parsed[1], uploadMaxBytes: parsed[4] };
}

function labelFor(element: Element, document: Document): string {
  const label = element.id ? [...document.querySelectorAll("label[for]")].find(candidate => candidate.getAttribute("for") === element.id) : undefined;
  const wrapped = element.closest("label");
  return clean((label ?? wrapped)?.textContent);
}

// Exact observed platform scaffolds, with generated identifiers and private operation masked.
// Any changed behavior or additional statement must be reviewed before it is accepted.
const inertScreeningScaffolds = new Set([
  "ecaf1403459b2e3dbbd0fcea74fe23fbe73e83da2fef11506d4b7c80e488c2d5",
  "f3f1947330471bc360203e33e72a8613d41dd2c7d9e7ab9c1a33628ee947e21b",
]);

function inertScreeningScript(script: Element, container: Element): boolean {
  if (script.hasAttribute("src")) return false;
  const source = (script.textContent ?? "").trim();
  const uiSelect = /^\$\(\s*(['"])#([A-Za-z_][\w:-]*)\1\s*\)\.uiSelect\(\s*\{\s*\}\s*\);?$/.exec(source);
  if (uiSelect) return [...container.querySelectorAll("select[id]")].some(select => select.id === uiSelect[2]);
  if (container.querySelector(".leader")) return false;
  const normalized = source.replace(/\bdf\d+_/g, "dfFORM_")
    .replace(/\breload_form\d+/g, "reload_formFORM")
    .replace(/request\.action\s*=\s*'[^'\\]*';/g, "request.action = 'fake-reload-operation';")
    .replace(/request\.modelId\s*=\s*'\d+';/g, "request.modelId = 'FORM';")
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n");
  return inertScreeningScaffolds.has(sha256(normalized));
}

function dynamicScreeningMarkup(container: Element, supportedScripts: Set<Element>, widgetAttributes: Map<Element, Set<string>>): boolean {
  if (container.querySelector(".leader")) return true;
  const inertWizardAttributes: Record<string, string> = {
    "data-additional-step-validation": "validatePreScreenQuestions()",
    "data-display-condition": "", "data-allow-skip": "false", "data-status": "incomplete", "data-ajax": "",
  };
  return [container, ...container.querySelectorAll("*")].some(element => [...element.attributes].some(attribute => {
    if (/^on/i.test(attribute.name)) return Boolean(attribute.value.trim());
    if (!attribute.name.startsWith("data-")) return false;
    if (widgetAttributes.get(element)?.has(attribute.name)) return false;
    return element !== container || inertWizardAttributes[attribute.name] !== attribute.value;
  })) || [...container.querySelectorAll("script")].some(script => !supportedScripts.has(script) && !inertScreeningScript(script, container));
}

function parseQuestions(container: Element | null, document: Document, blockers: string[]): ApplicationQuestion[] {
  if (!container) return [];
  const questions: ApplicationQuestion[] = [];
  const checkboxes = screeningCheckboxWidgets(container);
  const selects = screeningSelectOtherWidgets(container);
  const widgets = {
    scripts: new Set([...checkboxes.scripts, ...selects.scripts]),
    auxiliaryControls: new Set([...checkboxes.auxiliaryControls, ...selects.auxiliaryControls]),
    requiredNames: checkboxes.requiredNames,
  };
  const controls = [...container.querySelectorAll("input,select,textarea")].filter(control => active(control) && control.getAttribute("type")?.toLowerCase() !== "hidden" && !widgets.auxiliaryControls.has(control));
  // Dynamic questions cannot safely be reconstructed from static HTML.
  if (dynamicScreeningMarkup(container, widgets.scripts, selects.inertAttributes)) {
    blockers.push("Pre-screening questions contain unsupported dynamic behavior.");
  }
  const groups = new Map<string, Element[]>();
  for (const control of controls) {
    const key = name(control);
    if (!key || key.includes("${")) { blockers.push("A pre-screening control has no supported field name."); continue; }
    groups.set(key, [...(groups.get(key) ?? []), control]);
  }
  for (const [id, group] of groups) {
    const first = group[0]!;
    const inputType = first.tagName === "INPUT" ? (first.getAttribute("type") ?? "text").toLowerCase() : first.tagName.toLowerCase();
    const legend = first.closest("fieldset")?.querySelector("legend");
    const label = (group.length > 1 ? clean(legend?.textContent) : "") || labelFor(first, document) || clean(first.closest(".js--question--container")?.querySelector("label.label")?.textContent);
    if (!label) { blockers.push("A pre-screening question has no supported label."); continue; }
    const question: ApplicationQuestion = { id, label, type: "unsupported", required: widgets.requiredNames.has(id) || group.some(required) || clean(legend?.textContent).startsWith("*") };
    if ((inputType === "radio" || inputType === "checkbox") && group.every(control => control.tagName === "INPUT" && control.getAttribute("type")?.toLowerCase() === inputType)) {
      const options = group.map(control => ({ id: control.getAttribute("value") ?? "on", label: labelFor(control, document) }));
      if (options.some(option => !option.label || !option.id) || new Set(options.map(option => option.id)).size !== options.length) blockers.push("A pre-screening choice has ambiguous values or labels.");
      if (inputType === "checkbox" && group.length > 1 && group.some(required)) blockers.push("Required individual checkboxes need an unsupported group constraint.");
      question.type = inputType === "radio" ? "single_choice" : group.length === 1 ? "boolean" : "multiple_choice";
      question.options = options;
      if (question.type === "boolean" && question.required) question.mustBeTrue = true;
    } else if (group.length === 1 && inputType === "select") {
      question.type = first.hasAttribute("multiple") ? "multiple_choice" : "single_choice";
      question.options = [...first.querySelectorAll("option")].filter(option => !option.hasAttribute("disabled") && !option.closest("optgroup[disabled]") && option.getAttribute("value") !== "").map(option => ({ id: option.getAttribute("value") ?? option.textContent ?? "", label: clean(option.textContent) }));
      if (!question.options.length || question.options.some(option => !option.id || !option.label) || new Set(question.options.map(option => option.id)).size !== question.options.length) blockers.push("A pre-screening choice has ambiguous values or labels.");
    } else if (group.length === 1 && ["text", "textarea", "number"].includes(inputType)) {
      question.type = inputType === "number" ? "number" : "text";
      if (inputType === "number") question.integer = first.getAttribute("step") !== "any";
      for (const [attribute, property] of [["maxlength", "maxLength"], ["min", "min"], ["max", "max"]] as const) {
        const raw = first.getAttribute(attribute);
        if (raw !== null) {
          const parsed = Number(raw);
          if (!raw.trim() || !Number.isFinite(parsed) || (property === "maxLength" && (!Number.isInteger(parsed) || parsed < 0))) blockers.push("A pre-screening question has unsupported constraints.");
          else question[property] = parsed;
        }
      }
      if (inputType === "number" && first.getAttribute("step") !== "any" && !first.hasAttribute("min") && first.hasAttribute("value") && !Number.isInteger(Number(first.getAttribute("value")))) blockers.push("A pre-screening question has an unsupported numeric step base.");
      if (first.hasAttribute("pattern") || first.hasAttribute("minlength") || (inputType === "number" && first.hasAttribute("step") && first.getAttribute("step") !== "any" && first.getAttribute("step") !== "1")) blockers.push("A pre-screening question has unsupported constraints.");
    } else blockers.push("A pre-screening question uses an unsupported control.");
    questions.push(question);
  }
  if (!questions.length) {
    const scaffold = container.querySelector(".dfForm")?.cloneNode(true) as Element | undefined;
    if (scaffold) for (const inert of scaffold.querySelectorAll("script,style")) inert.remove();
    const emptyScaffold = controls.length === 0 && scaffold && !clean(scaffold.textContent)
      && !container.querySelector(".js--question--container")
      && container.querySelector('input[type=hidden][name=isSpiralRobot][value=true]');
    if (!emptyScaffold) blockers.push("Pre-screening questions could not be understood.");
  }
  return questions;
}

/** Parse the observed wizard contract; all operation tokens remain adapter-private. */
export function parseApplicationPage(html: string): ParsedApplicationPage {
  const { document } = parseHTML(html);
  // linkedom preserves original attribute case, unlike browser HTML DOMs.
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name !== attribute.name.toLowerCase()) {
        element.removeAttribute(attribute.name);
        element.setAttribute(attribute.name.toLowerCase(), attribute.value);
      }
    }
  }
  const form = document.querySelector("#applyForm");
  if (!form) throw new ProtocolChangedError("Missing application wizard form");
  const blockers: string[] = [];
  const privateFields: Record<string, string> = Object.create(null);
  const known = new Set<Element>();
  for (const control of form.querySelectorAll("input[type=hidden]")) {
    if (name(control).includes("${")) { known.add(control); continue; }
    if (active(control) && name(control) && (["uiForm", "postingId", "wizardMode", "wizardStateId"].includes(name(control)) || (control.closest("#preScreenQuestions") && name(control) === "isSpiralRobot" && value(control) === "true"))) {
      if (Object.hasOwn(privateFields, name(control))) blockers.push("Application wizard has duplicate private fields.");
      privateFields[name(control)] = value(control);
      known.add(control);
    }
  }
  const packageControl = form.querySelector("#packageName[name=name]");
  if (packageControl) known.add(packageControl);
  for (const control of form.querySelectorAll('input[type=radio][name=applyOption]')) known.add(control);
  const requirements: DocumentRequirement[] = [];
  const documents: LibraryDocument[] = [];
  const seenTypes = new Set<string>();
  for (const fieldset of form.querySelectorAll("#applicationOptions fieldset.input__group")) {
    const legend = fieldset.querySelector("legend");
    let rawLabel = clean((legend?.querySelector("span") ?? legend)?.textContent).replace(/\s*\(Clear Selection\)\s*$/, "");
    const radios = [...fieldset.querySelectorAll('input[type=radio][data-dt-id]')];
    const upload = fieldset.querySelector(".js--btn--upload-new-doc[data-dt-id]");
    const metadataLabel = clean(upload?.getAttribute("data-dt-name"));
    if ((!rawLabel || rawLabel.includes("�")) && metadataLabel && !metadataLabel.includes("�")) rawLabel = (rawLabel.startsWith("*") ? "*" : "") + metadataLabel;
    const typeIds = new Set([...radios.map(control => control.getAttribute("data-dt-id")!), ...(upload ? [upload.getAttribute("data-dt-id")!] : [])]);
    if (!typeIds.size && fieldset.querySelector('[name=applyOption]')) continue;
    if (typeIds.size !== 1 || !rawLabel) { blockers.push("A document requirement could not be understood."); continue; }
    const typeId = [...typeIds][0]!;
    if (seenTypes.has(typeId)) blockers.push("Document requirements have duplicate type identifiers.");
    seenTypes.add(typeId);
    const label = rawLabel.replace(/^\*\s*/, "") || clean(upload?.getAttribute("data-dt-name"));
    const normalized = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const system = normalized === "grade report" || normalized === "university of waterloo co-op work history";
    const role = normalized === "resume" ? "resume" : system ? "system" : "attachment";
    const requirement: DocumentRequirement = { id: typeId, typeId, label, required: rawLabel.startsWith("*") || radios.some(control => control.classList.contains("customPkg") || required(control)), role };
    const inventory: LibraryDocument[] = [];
    for (const radio of radios) {
      known.add(radio);
      const documentName = clean(radio.closest("label")?.querySelector("span.label--span > div:last-child")?.textContent ?? radio.closest("label")?.querySelector("span > div:last-child")?.textContent);
      if (name(radio) !== typeId || !value(radio) || !documentName) { blockers.push("A document option could not be understood."); continue; }
      const entry: LibraryDocument = { id: value(radio), typeId, name: documentName, revision: "pending", state: "unknown", source: system ? "system" : "library" };
      if (inventory.some(existing => existing.id === entry.id)) blockers.push("Document options have duplicate identifiers.");
      inventory.push(entry);
      documents.push(entry);
      if (radio.hasAttribute("checked")) {
        if (requirement.selectedDocument) blockers.push("A document requirement has multiple selections.");
        requirement.selectedDocument = entry;
      }
    }
    if (system && requirement.required && !requirement.selectedDocument) blockers.push("A required system document is unavailable or ambiguous.");
    if (!system && !upload && requirement.required && role !== "resume") blockers.push("A required attachment has no supported upload control.");
    for (const select of form.querySelectorAll("select[name]")) {
      if (name(select) === `selectExisting_${typeId}`) known.add(select);
    }
    requirements.push(requirement);
  }
  if (requirements.filter(requirement => requirement.role === "resume").length !== 1) blockers.push("Application must have exactly one understood resume requirement.");
  const preScreen = form.querySelector("#preScreenQuestions");
  const questions = parseQuestions(preScreen, document as unknown as Document, blockers);
  if (questions.some(question => Object.hasOwn(privateFields, question.id) || seenTypes.has(question.id) || ["uiForm", "postingId", "wizardMode", "wizardStateId", "action", "applyOption", "name"].includes(question.id))) blockers.push("Pre-screening fields conflict with application wizard fields.");
  for (const control of form.querySelectorAll("input[name],select[name],textarea[name],button[name]")) {
    if (!active(control) || !name(control) || known.has(control) || (control.closest("#preScreenQuestions") && control.getAttribute("type")?.toLowerCase() !== "hidden")) continue;
    blockers.push("Application wizard contains an unsupported named control.");
  }
  const uploadSaveFields: Record<string, string> = Object.create(null);
  for (const control of document.querySelectorAll("#fileUploadForm input[type=hidden][name]")) {
    if (["action", "postingId", "docType", "uiForm", "removeFile_docUpload", "docUploaded"].includes(name(control))) {
      if (Object.hasOwn(uploadSaveFields, name(control))) blockers.push("Application upload has duplicate private fields.");
      uploadSaveFields[name(control)] = value(control);
    }
  }
  const uploadAction = value(document.querySelector("#fileUploadAction_docUpload") ?? document.createElement("input"));
  if (!uploadAction || !uploadSaveFields.action) throw new ProtocolChangedError("Missing application upload operations");
  return { requirements, documents, questions, blockers: [...new Set(blockers)], privateFields, submitAction: discoverPageAction(html, "validateApplicationOptions"), confirmationAction: confirmationAction(html), uploadAction, uploadSaveFields, ...uploadConfiguration(html), packageName: packageControl ? value(packageControl) : "" };
}
