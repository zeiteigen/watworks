import { parseHTML } from "linkedom";

/**
 * Runs `body` with a linkedom document installed as the global one, restoring it afterwards.
 * Async bodies keep it installed until pending PDF loads have settled.
 */
export function withDom<T>(html: string, body: (document: Document, window: Window & typeof globalThis) => T): T {
  const dom = parseHTML(html), previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  // linkedom's select has a read-only value, and inputs have no valueAsNumber.
  Object.defineProperty(dom.window.HTMLSelectElement.prototype, "value", { configurable: true,
    get(this: HTMLSelectElement) { return [...this.options].find(option => option.selected)?.value ?? this.options[0]?.value ?? ""; },
    set(this: HTMLSelectElement, value: string) { for (const option of this.options) option.selected = option.value === value; } });
  Object.defineProperty(dom.window.HTMLInputElement.prototype, "valueAsNumber", { configurable: true,
    get(this: HTMLInputElement) { return this.value === "" ? NaN : Number(this.value); } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  // Only undo our own install: a later test may already have put its document in place.
  const restore = () => {
    if ((globalThis as { document?: unknown }).document !== dom.document) return;
    if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document");
  };
  let result: T;
  try { result = body(dom.document as unknown as Document, dom.window as unknown as Window & typeof globalThis); }
  catch (error) { restore(); throw error; }
  if (result instanceof Promise) return result.then(value => new Promise(resolve => setTimeout(resolve, 20)).then(() => value)).finally(restore) as T;
  // Rejected PDF loads settle on later ticks; keep the document until then.
  setTimeout(restore, 20);
  return result;
}
