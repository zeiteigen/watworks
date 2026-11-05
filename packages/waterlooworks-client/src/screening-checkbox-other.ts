/** Recognize the observed optional Other pair. Only predefined answers are supported. */
export function screeningCheckboxOther(group: Element, id: string, controls: Element[]): Element[] | undefined {
  if (controls.length !== 2) return;
  const toggle = controls.find(control => control.id === `otherCheckbox_${id}_`);
  const text = controls.find(control => control.id === `other_${id}`);
  const wrapper = toggle?.closest('.js__checkbox--group--other');
  if (!toggle || !text || !wrapper || !group.contains(wrapper) || !wrapper.contains(text)) return;
  if (toggle.tagName !== 'INPUT' || toggle.getAttribute('type') !== 'checkbox' || toggle.getAttribute('name')
    || !toggle.classList.contains('js__checkbox--group--other__checkbox')
    || !toggle.classList.contains(`question_${id}_other`) || !toggle.classList.contains(`question_${id}_`)
    || toggle.hasAttribute('checked') || toggle.hasAttribute('disabled') || toggle.hasAttribute('value')) return;
  if (text.tagName !== 'INPUT' || text.getAttribute('type') !== 'text' || text.getAttribute('name') !== `other_${id}`
    || (text.getAttribute('value') ?? '') !== '' || !text.closest('.js__other--textbox__container')
    || ['disabled', 'required', 'pattern', 'minlength', 'maxlength'].some(attribute => text.hasAttribute(attribute))) return;
  return [toggle, text];
}
