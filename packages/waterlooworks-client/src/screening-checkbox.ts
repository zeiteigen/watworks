import { sha256 } from "../../shared/src/sha256.js";
import { screeningCheckboxOther } from "./screening-checkbox-other.js";

// Observed platform widget: unlimited static choices, optional unused Other, no leader
// reloads, and no saved selections. Changes to any executable statement fail closed.
const CHOICE_SCRIPT = "cc54b3e8302a754b451270fcc8a62399aee24ff177f83410183d75de645ddcdc";
const REQUIRED_WIDGET = "098633740018fa3ad33afc778610ff4b2e6994644b37cca130ea376cecad2cb5";
const normalizedLines = (source: string) => source.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n");

export function screeningCheckboxWidgets(container: Element) {
  const scripts = new Set<Element>();
  const auxiliaryControls = new Set<Element>();
  const requiredNames = new Set<string>();
  for (const group of container.querySelectorAll('.js__checkbox-group[id]')) {
    const match = /^question_(\d+)_$/.exec(group.id);
    if (!match) continue;
    const id = match[1]!;
    const fieldName = `question_${id}`;
    const question = group.closest('.js--question--container');
    if (!question || question.querySelectorAll('.js__checkbox-group').length !== 1 || question.querySelector('.leader')) continue;
    const widgetScripts = [...question.querySelectorAll('script')];
    if (widgetScripts.length !== 2 || widgetScripts.some(script => script.hasAttribute('src'))) continue;
    const normalize = (source: string) => source.replaceAll(fieldName, 'question_QUESTION')
      .replaceAll(`otherCheckbox_${id}`, 'otherCheckbox_QUESTION').replaceAll(`other_${id}`, 'other_QUESTION');
    const choiceScript = widgetScripts.find(script => /var choices = /.test(script.textContent ?? ''));
    const initScript = widgetScripts.find(script => script !== choiceScript);
    if (!choiceScript || !initScript || sha256(normalizedLines(normalize(initScript.textContent ?? ''))) !== REQUIRED_WIDGET) continue;
    const source = choiceScript.textContent ?? '';
    const choicesLiteral = /var choices = (\[[^\n]*\]);/.exec(source);
    if (!choicesLiteral || sha256(normalizedLines(normalize(source).replace(/var choices = \[[^\n]*\];/, 'var choices = CHOICES;'))) !== CHOICE_SCRIPT) continue;
    let choices: unknown;
    try { choices = JSON.parse(choicesLiteral[1]!); } catch { continue; }
    if (!Array.isArray(choices) || choices.length < 2 || choices.some(value => typeof value !== 'string' || !value) || new Set(choices).size !== choices.length) continue;
    const controls = [...question.querySelectorAll('input,select,textarea')];
    const options = controls.filter(control => control.getAttribute('name') === fieldName);
    const auxiliary = controls.filter(control => !options.includes(control));
    if (options.length !== choices.length || options.some((control, index) => control.tagName !== 'INPUT' || control.getAttribute('type') !== 'checkbox' || control.getAttribute('value') !== choices[index] || !control.classList.contains(`${fieldName}_`) || control.hasAttribute('disabled') || control.hasAttribute('required'))) continue;
    const selectAll = auxiliary.filter(control => control.tagName === 'INPUT' && control.getAttribute('type') === 'checkbox' && !control.getAttribute('name') && control.closest('.js__select--all') && control.closest('.js__checkbox-group') === group);
    if (selectAll.length !== 1) continue;
    const remaining = auxiliary.filter(control => control !== selectAll[0]);
    const other = remaining.length ? screeningCheckboxOther(group, id, remaining) : [];
    if (!other) continue;
    widgetScripts.forEach(script => scripts.add(script));
    [...selectAll, ...other].forEach(control => auxiliaryControls.add(control));
    requiredNames.add(fieldName);
  }
  return { scripts, auxiliaryControls, requiredNames };
}
