const installed = new WeakSet<Document>();
const attribute = "data-submission-developer-mode";

export function developerModeEnabled(document: Document): boolean {
  return document.documentElement.hasAttribute(attribute);
}

export function setDeveloperMode(document: Document, enabled: boolean): void {
  const changed = developerModeEnabled(document) !== enabled;
  document.documentElement.toggleAttribute(attribute, enabled);
  for (const controls of document.querySelectorAll<HTMLElement>("#submission-developer")) controls.hidden = !enabled;
  if (changed) document.dispatchEvent(new Event("submission-developer-mode-changed"));
}

/** A page-local shortcut; typing in forms must never toggle developer controls. */
export function installDeveloperMode(document: Document): void {
  if (installed.has(document)) return;
  installed.add(document);
  let sequence = "", lastKeyAt = 0;
  document.addEventListener("keydown", event => {
    const target = event.target as HTMLElement | null;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat ||
        target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
      sequence = "";
      return;
    }
    const now = Date.now();
    if (now - lastKeyAt > 2000) sequence = "";
    lastKeyAt = now;
    sequence = (sequence + (event.key.length === 1 ? event.key.toLowerCase() : " ")).slice(-5);
    if (sequence === "debug") {
      setDeveloperMode(document, true);
      sequence = "";
    }
  });
}
