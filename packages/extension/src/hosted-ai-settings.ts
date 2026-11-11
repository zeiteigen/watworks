import type { Tone } from "./hosted-queue.js";
import { hostedRequest, type HostedWorkspace } from "./hosted-client.js";

const styleNames = { openai: "OpenAI-style", anthropic: "Anthropic-style" } as const;
const modelHints = { openai: "e.g. gpt-5", anthropic: "e.g. claude-opus-5-5" } as const;
const urlHints = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" } as const;

export function aiConnectionSummary(ai: HostedWorkspace["ai"]): string {
  if (ai.apiKey) {
    const key = ai.apiKey.keyHint ? ` · key ending ${ai.apiKey.keyHint}` : "";
    const host = ai.apiKey.baseUrl ? ` · ${new URL(ai.apiKey.baseUrl).hostname}` : "";
    return `Using your ${styleNames[ai.apiKey.style]} API key · ${ai.apiKey.model}${host}${key}.${ai.chatgptConnected ? " Remove it to go back to ChatGPT." : ""}`;
  }
  return ai.reason || (ai.connected ? "Your ChatGPT account is connected." : "Connect ChatGPT or add an API key to enable search and application preparation.");
}

/** The key only ever travels from this form to the hosted API; it is never read back or kept on the page. */
export function createAiSettings(root: Document, report: (text: string, tone?: Tone) => void, refresh: () => Promise<void>): (ai: HostedWorkspace["ai"]) => void {
  const form = root.querySelector<HTMLFormElement>("#api-key-form")!;
  const remove = root.querySelector<HTMLButtonElement>("#api-key-remove")!;
  const field = <T extends Element>(name: string) => form.querySelector<T>(`[name="${name}"]`)!;
  const style = field<HTMLSelectElement>("style"), model = field<HTMLInputElement>("model"), baseUrl = field<HTMLInputElement>("baseUrl"), apiKey = field<HTMLInputElement>("apiKey");
  const showHints = () => {
    const value = style.value as keyof typeof modelHints;
    model.placeholder = modelHints[value]; baseUrl.placeholder = urlHints[value];
  };
  style.addEventListener("change", showHints); showHints();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const save = form.querySelector<HTMLButtonElement>("button[type=submit]")!; save.disabled = true;
    report("Checking your API key with one small request…");
    try {
      const url = baseUrl.value.trim();
      await hostedRequest("/ai-key", { method: "POST", body: JSON.stringify({ style: style.value, apiKey: apiKey.value, model: model.value, ...(url ? { baseUrl: url } : {}) }) });
      apiKey.value = "";
      report("API key saved. Searches and letters now use it.");
      await refresh();
    } catch (error) { report(error instanceof Error ? error.message : String(error), "error"); }
    finally { save.disabled = false; }
  });
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try { await hostedRequest("/ai-key/remove", { method: "POST", body: "{}" }); report("API key removed."); await refresh(); }
    catch (error) { report(error instanceof Error ? error.message : String(error), "error"); }
    finally { remove.disabled = false; }
  });
  let shownKey: string | null = null;
  return ai => {
    root.querySelector("#ai-reason")!.textContent = aiConnectionSummary(ai);
    const connect = root.querySelector<HTMLButtonElement>("#chatgpt-connect")!;
    connect.textContent = ai.chatgptConnected ?? ai.connected ? "Reconnect ChatGPT ↗" : "Continue with ChatGPT ↗";
    connect.disabled = false;
    remove.hidden = !ai.apiKey && !ai.apiKeyUnreadable;
    // Refreshes must not overwrite what is being typed: only fill in on a change of saved key.
    const key = ai.apiKey ? JSON.stringify(ai.apiKey) : null;
    if (key !== shownKey) {
      shownKey = key;
      if (ai.apiKey) { style.value = ai.apiKey.style; model.value = ai.apiKey.model; baseUrl.value = ai.apiKey.baseUrl ?? ""; showHints(); }
    }
  };
}
