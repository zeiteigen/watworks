import type { Tone } from "./hosted-queue.js";
import { hostedRequest } from "./hosted-client.js";

interface LetterPreferences { template: string; defaultTemplate: string; markers: string[] }

/** Loaded apart from the workspace so queue refreshes never replace what is being edited. */
export function createLetterSettings(root: Document, report: (text: string, tone?: Tone) => void): () => Promise<void> {
  const form = root.querySelector<HTMLFormElement>("#cover-letter-form")!;
  const template = form.querySelector<HTMLTextAreaElement>('[name="template"]')!;
  const useDefault = root.querySelector<HTMLButtonElement>("#letter-template-default")!;
  const markers = root.querySelector<HTMLElement>("#letter-template-markers")!;
  let defaultTemplate = "";
  useDefault.addEventListener("click", () => { template.value = defaultTemplate; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const save = form.querySelector<HTMLButtonElement>("button[type=submit]")!; save.disabled = true;
    try {
      await hostedRequest("/cover-letter-preferences", { method: "POST", body: JSON.stringify({ template: template.value }) });
      report(template.value.trim() ? "Cover letter template saved. New letters use your template." : "Cover letter template saved. New letters use the default template.");
    } catch (error) { report(error instanceof Error ? error.message : String(error), "error"); }
    finally { save.disabled = false; }
  });
  return async () => {
    const state = root.querySelector<HTMLElement>("#letter-settings-state")!;
    let preferences: LetterPreferences;
    // Saving an unloaded form would erase saved preferences, so it stays disabled until a load succeeds.
    try { preferences = await hostedRequest<LetterPreferences>("/cover-letter-preferences"); }
    catch { state.textContent = "Your cover letter template could not be loaded. Reload this page to try again."; return; }
    state.textContent = "";
    template.value = preferences.template; defaultTemplate = preferences.defaultTemplate;
    useDefault.disabled = false; form.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = false;
    markers.replaceChildren(...preferences.markers.flatMap((name, index) => {
      const code = root.createElement("code"); code.textContent = `%%WAT:${name}%%`;
      return index ? [root.createTextNode(" "), code] : [code];
    }));
  };
}
