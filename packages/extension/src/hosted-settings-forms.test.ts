import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { aiConnectionSummary, createAiSettings } from "./hosted-ai-settings.js";
import { createLetterSettings } from "./hosted-letter-settings.js";

const page = () => withSelectValue(parseHTML(`<html><body><p id="ai-reason"></p><button id="chatgpt-connect"></button><form id="api-key-form"><select name="style"><option value="openai">a</option><option value="anthropic">b</option></select><input name="model"><input name="baseUrl"><input name="apiKey"><button type="submit"></button><button id="api-key-remove" type="button"></button></form></body></html>`));
/** linkedom's select has a read-only value. */
function withSelectValue<T extends ReturnType<typeof parseHTML>>(dom: T): T {
  Object.defineProperty(dom.window.HTMLSelectElement.prototype, "value", { configurable: true,
    get(this: HTMLSelectElement) { return [...this.options].find(option => option.selected)?.value ?? this.options[0]?.value ?? ""; },
    set(this: HTMLSelectElement, value: string) { for (const option of this.options) option.selected = option.value === value; } });
  return dom;
}
const key = { style: "anthropic" as const, model: "claude-opus-5-5", baseUrl: "https://gateway.example.com/v1", keyHint: "wxyz" };

test("the connection summary names what is in use, without ever needing the key", () => {
  expect(aiConnectionSummary({ available: true, reason: "", connected: true, chatgptConnected: true, apiKey: key })).toBe("Using your Anthropic-style API key · claude-opus-5-5 · gateway.example.com · key ending wxyz. Remove it to go back to ChatGPT.");
  expect(aiConnectionSummary({ available: true, reason: "", connected: true, chatgptConnected: false, apiKey: { ...key, baseUrl: null, keyHint: null } })).toBe("Using your Anthropic-style API key · claude-opus-5-5.");
  expect(aiConnectionSummary({ available: true, reason: "", connected: true, chatgptConnected: true, apiKey: null })).toBe("Your ChatGPT account is connected.");
  expect(aiConnectionSummary({ available: false, reason: "Add one.", connected: false })).toBe("Add one.");
});

test("settings reflect a saved key once, so later refreshes cannot overwrite what is being typed", () => {
  const { document } = page();
  const show = createAiSettings(document as unknown as Document, () => {}, async () => {});
  const form = document.querySelector("form") as unknown as HTMLFormElement, field = (name: string) => form.querySelector(`[name=${name}]`) as HTMLInputElement;
  const remove = document.querySelector("#api-key-remove") as unknown as HTMLButtonElement, connect = document.querySelector("#chatgpt-connect")!;
  show({ available: false, reason: "", connected: false, chatgptConnected: false, apiKey: null });
  expect(remove.hidden).toBe(true); expect(connect.textContent).toContain("Continue with ChatGPT");
  show({ available: true, reason: "", connected: true, chatgptConnected: false, apiKey: key });
  expect(field("model").value).toBe("claude-opus-5-5"); expect(field("baseUrl").value).toBe("https://gateway.example.com/v1");
  expect(remove.hidden).toBe(false); expect(field("apiKey").value).toBe("");
  // An API key alone must not make the ChatGPT button claim a connection.
  expect(connect.textContent).toContain("Continue with ChatGPT");
  field("model").value = "being-typed";
  show({ available: true, reason: "", connected: true, chatgptConnected: false, apiKey: key });
  expect(field("model").value).toBe("being-typed");
});

test("cover letter preferences cannot be saved until they load, so a failed load cannot erase them", async () => {
  const { document } = parseHTML(`<html><body><form id="cover-letter-form"><textarea name="advice"></textarea><textarea name="template"></textarea><p id="letter-settings-state"></p><span id="letter-template-markers"></span><button type="submit" disabled></button><button id="letter-template-default" type="button" disabled></button></form></body></html>`);
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  const save = document.querySelector("button[type=submit]") as unknown as HTMLButtonElement;
  const load = createLetterSettings(document as unknown as Document, () => {});
  globalThis.chrome = { runtime: { sendMessage: async () => { throw new Error("no session"); } }, storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } } } as unknown as typeof chrome;
  try {
    await load();
    expect(save.disabled).toBe(true);
    expect(document.querySelector("#letter-settings-state")!.textContent).toContain("could not be loaded");
  } finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
});
