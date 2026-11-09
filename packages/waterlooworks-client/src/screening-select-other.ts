import { sha256 } from "../../shared/src/sha256.js";

// Observed platform widget: a static dropdown with an unused Other option and a
// hidden Other textbox. Only the predefined answers are supported; the Other
// option and textbox are excluded. Changes to any executable statement fail closed.
const CHOICE_SCRIPT = "703234c4b57ea37011237c15bf54f5ad4f52ec8cb02cc7c185e88bc2de6513e6";
const normalizedLines = (source: string) => source.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n");
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

export function normalizeSelectOtherScript(source: string, id: string): string {
  return normalizedLines(source.replaceAll(`dropdownOther_${id}`, "dropdownOther_QUESTION")
    .replaceAll(`other_${id}`, "other_QUESTION").replaceAll(`question_${id}`, "question_QUESTION")
    .replace(/var choices = \[[^\n]*\];/, "var choices = CHOICES;"));
}

/** The textbox may only carry the observed inert attributes, all empty except its length rule. */
function inertOtherText(control: Element, id: string): boolean {
  const allowed: Record<string, string> = { class: "", style: "", "data-rule-maxlength": "255", type: "text", name: `other_${id}`, id: `other_${id}_`, value: "", onkeydown: "", onclick: "", ondblclick: "", onfocus: "", placeholder: "" };
  return control.tagName === "INPUT" && [...control.attributes].every(attribute => Object.hasOwn(allowed, attribute.name)
    && (attribute.name === "class" ? attribute.value.trim().split(/\s+/).every(name => ["input--box", "display--block"].includes(name))
      : attribute.name === "style" ? !attribute.value.trim() : attribute.value === allowed[attribute.name]))
    && ["type", "name", "id", "value"].every(name => control.hasAttribute(name))
    && !!control.closest(".input__group.display--none");
}

export function screeningSelectOtherWidgets(container: Element) {
  const scripts = new Set<Element>();
  const auxiliaryControls = new Set<Element>();
  const inertAttributes = new Map<Element, Set<string>>();
  for (const question of container.querySelectorAll(".js--question--container")) {
    const select = question.querySelector("select[id]");
    const match = select && /^question_(\d+)_$/.exec(select.id);
    if (!select || !match || question.querySelector(".leader")) continue;
    const id = match[1]!;
    if (select.getAttribute("name") !== `question_${id}` || select.hasAttribute("multiple") || select.hasAttribute("disabled")) continue;
    const controls = [...question.querySelectorAll("input,select,textarea")];
    const other = controls.filter(control => control !== select);
    if (controls.length !== 2 || other.length !== 1 || !inertOtherText(other[0]!, id)) continue;
    const widgetScripts = [...question.querySelectorAll("script")].filter(script => !/^\$\(\s*'#question_\d+_'\s*\)\.uiSelect\(\s*\{\s*\}\s*\);?$/.test((script.textContent ?? "").trim()));
    if (widgetScripts.length !== 1 || widgetScripts[0]!.hasAttribute("src")) continue;
    const source = widgetScripts[0]!.textContent ?? "";
    const choicesLiteral = /var choices = (\[[^\n]*\]);/.exec(source);
    if (!choicesLiteral || sha256(normalizeSelectOtherScript(source, id)) !== CHOICE_SCRIPT) continue;
    let choices: unknown;
    try { choices = JSON.parse(choicesLiteral[1]!); } catch { continue; }
    // The page script keeps only the text before "|"; such choices would not match their option values.
    if (!Array.isArray(choices) || choices.length < 2 || choices.some(value => typeof value !== "string" || !value.trim() || value.includes("|") || value === "Other") || new Set(choices).size !== choices.length) continue;
    const options = [...select.querySelectorAll("option")];
    if (options.length !== choices.length + 2 || options.some(option => option.hasAttribute("selected") || option.hasAttribute("disabled")) || select.querySelector("optgroup")) continue;
    const [empty, ...rest] = options;
    const otherOption = rest.pop()!;
    if (empty!.getAttribute("value") !== "" || text(empty!) !== "Select") continue;
    if (otherOption.id !== `dropdownOther_${id}_` || otherOption.getAttribute("class") !== `other_${id}` || otherOption.getAttribute("value") !== "" || text(otherOption) !== "Other") continue;
    if (rest.some((option, index) => option.getAttribute("value") !== choices[index] || text(option) !== choices[index])) continue;
    scripts.add(widgetScripts[0]!);
    auxiliaryControls.add(other[0]!);
    inertAttributes.set(other[0]!, new Set(["data-rule-maxlength"]));
  }
  return { scripts, auxiliaryControls, inertAttributes };
}
