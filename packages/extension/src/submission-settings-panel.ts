import { DEFAULT_SUBMISSION_ENDPOINT, getSubmissionSettings, getSubmissionStatus, saveSubmissionSettings, validateSubmissionEndpoint, validateSubmissionHeaders } from "./submission-client.js";
import { SUBMISSION_SETTINGS_MARKUP } from "./submission-settings-markup.js";
import { getInsiderAccount } from "./insider-account.js";
import { developerModeEnabled, installDeveloperMode, setDeveloperMode } from "./developer-mode.js";

/** Credentials remain inside this trusted extension view. */
export function createSubmissionSettingsPanel(): HTMLElement {
  installDeveloperMode(document);
  const root = document.createElement("section");
  root.className = "card submission-settings";
  root.innerHTML = SUBMISSION_SETTINGS_MARKUP;
  const element = <T extends HTMLElement>(id: string) => root.querySelector(`#submission-${id}`) as T;
  const endpoint = element<HTMLInputElement>("endpoint"), headers = element<HTMLTextAreaElement>("headers"), status = element<HTMLParagraphElement>("status");
  const accountStatus = element<HTMLParagraphElement>("account-status");
  element("developer").hidden = !developerModeEnabled(document);
  element("hide-developer").addEventListener("click", () => {
    setDeveloperMode(document, false);
    void run(async () => {
      const saved = await getSubmissionSettings();
      endpoint.value = saved.endpoint;
      headers.value = JSON.stringify(saved.headers, null, 2);
      element("destination").textContent = `Session transfer destination: ${saved.endpoint}`;
      return "Developer settings hidden. Unsaved endpoint changes were discarded.";
    });
  });
  element("default").addEventListener("click", () => {
    endpoint.value = DEFAULT_SUBMISSION_ENDPOINT;
    headers.value = "{}";
    status.textContent = "Cloudflare selected. Save endpoint settings to connect.";
  });
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
  async function run(task: () => Promise<string>) {
    buttons.forEach(button => { button.disabled = true; });
    try { status.textContent = await task(); } catch (error) { status.textContent = error instanceof Error ? error.message : "Submission settings failed"; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  async function describeStatus(): Promise<string> {
    const result = await getSubmissionStatus();
    return !result.connected ? "Submission server is unavailable." : !result.authenticated ? "Server connected. Your session will be checked and shared when you apply or discovery needs to run." : `Session available. ${result.fillOnly ? "This server also supports Fill form only." : "This server supports approved application submissions."}`;
  }
  async function refreshAccountStatus(): Promise<void> {
    const account = await getInsiderAccount();
    const reason = account && "reason" in account ? account.reason : undefined;
    accountStatus.textContent = account ? `${account.insider ? "Insider" : "Core"} plan${account.email ? ` · ${account.email}` : ""}${account.term ? ` · ${account.term}` : ""}${reason ? ` · ${reason}` : ""}` : "Core plan · Sign in to WaterlooWorks for account status.";
  }
  element("save").addEventListener("click", () => {
    // Request the selected origin synchronously within this user gesture.
    let validated: string, proxyHeaders: Record<string, string>;
    try { validated = validateSubmissionEndpoint(endpoint.value); proxyHeaders = validateSubmissionHeaders(JSON.parse(headers.value)); }
    catch (error) { status.textContent = error instanceof Error ? error.message : "Invalid settings"; return; }
    const url = new URL(validated);
    const permission = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    void run(async () => {
      if (!(await permission)) throw new Error("Endpoint permission was not granted");
      const saved = await saveSubmissionSettings(validated, proxyHeaders); endpoint.value = validated; element("destination").textContent = `Session transfer destination: ${validated}`;
      return `Endpoint saved. ${await describeStatus()}${saved.warning ? ` ${saved.warning}` : ""}`;
    });
  });
  element("test").addEventListener("click", () => void run(describeStatus));
  void run(async () => {
    const settings = await getSubmissionSettings(); endpoint.value = settings.endpoint; headers.value = JSON.stringify(settings.headers, null, 2);
    element("destination").textContent = `Session transfer destination: ${settings.endpoint}`;
    return "Your WaterlooWorks session syncs automatically when you apply or discovery needs to run.";
  });
  void refreshAccountStatus().catch(() => { accountStatus.textContent = "Account status unavailable."; });
  endpoint.addEventListener("input", () => { element("destination").textContent = `Session transfer destination: ${endpoint.value}`; });
  return root;
}
