import { hostedRequest } from "./hosted-client.js";
import type { ResumeReviewMode } from "../../shared/src/resume-changes.js";

interface MaterialPreferences { letterPrompt: string; resumePrompt: string; resumeReview: ResumeReviewMode; defaultLetterPrompt: string; defaultResumePrompt: string }

/** Writing prompts in Materials. Loaded apart from the queue so polling never replaces what is being edited. */
export function createMaterialSettings(root: Document, report: (text: string) => void, onSaved: () => void = () => {}): () => Promise<void> {
  const form = root.querySelector<HTMLFormElement>("#material-prompts-form")!;
  const field = (name: string) => form.querySelector<HTMLTextAreaElement & HTMLSelectElement>(`[name="${name}"]`)!;
  const letter = field("letterPrompt"), resume = field("resumePrompt"), review = field("resumeReview");
  const state = root.querySelector<HTMLElement>("#prompt-settings-state")!;
  const save = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const defaults: Record<string, string> = {};
  for (const button of form.querySelectorAll<HTMLButtonElement>("[data-prompt-default]")) {
    button.addEventListener("click", () => { const name = button.dataset.promptDefault!; field(name).value = defaults[name] ?? ""; state.textContent = "Default restored. Save to use it."; });
  }
  form.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true;
    try {
      await hostedRequest("/material-preferences", { method: "POST", body: JSON.stringify({ letterPrompt: letter.value, resumePrompt: resume.value, resumeReview: review.value }) });
      state.textContent = "Writing prompts saved. New drafts use them."; report("Writing prompts saved."); onSaved();
    } catch (error) { state.textContent = error instanceof Error ? error.message : String(error); }
    finally { save.disabled = false; }
  });
  return async () => {
    let preferences: MaterialPreferences;
    // Saving an unloaded form would replace saved prompts, so it stays disabled until a load succeeds.
    try { preferences = await hostedRequest<MaterialPreferences>("/material-preferences"); }
    catch { state.textContent = "Your writing prompts could not be loaded. Reload this page to try again."; return; }
    letter.value = preferences.letterPrompt; resume.value = preferences.resumePrompt; review.value = preferences.resumeReview;
    defaults.letterPrompt = preferences.defaultLetterPrompt; defaults.resumePrompt = preferences.defaultResumePrompt;
    for (const button of form.querySelectorAll<HTMLButtonElement>("[data-prompt-default], button[type=submit]")) button.disabled = false;
    state.textContent = "";
  };
}
