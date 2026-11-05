import { createSubmissionSettingsPanel } from "./submission-settings-panel.js";
import { createDashboardRequest, WORKSPACE_SERVICE } from "./dashboard-api.js";
import { getInsiderAccount } from "./insider-account.js";
import { developerModeEnabled, installDeveloperMode } from "./developer-mode.js";

installDeveloperMode(document);

const request=createDashboardRequest(message => chrome.runtime.sendMessage(message));
Object.assign(globalThis, {
  dashboardEventsUrl:WORKSPACE_SERVICE+"/api/application-events",
  createSubmissionSettingsPanel,
  submissionDeveloperModeEnabled: () => developerModeEnabled(document),
  dashboardRequest: request,
  getInsiderAccount,
  hasInsiderAccount: async () => (await getInsiderAccount())?.insider === true,
});

const controls = document.createElement("div");
const button = document.createElement("button");
button.type = "button";
button.className = "secondary";
button.textContent = "Start workspace service";
const serviceStatus = document.createElement("p");
serviceStatus.className = "meta";
serviceStatus.setAttribute("role", "status");
controls.append(button, serviceStatus);
document.querySelector(".masthead")!.append(controls);
async function start(): Promise<void> {
  button.disabled = true;
  serviceStatus.textContent = "Connecting to workspace…";
  try {
    const reply = await chrome.runtime.sendMessage({ type: "startService" });
    if (!reply?.ok) throw new Error(reply?.error ?? "Workspace startup failed");
    serviceStatus.textContent = "Workspace service is running.";
    document.dispatchEvent(new Event("workspace-connected"));
  } catch (error) { serviceStatus.textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; }
}
button.addEventListener("click", () => void start());
void start();

const settingsStyle=document.createElement("link");
settingsStyle.rel="stylesheet";
settingsStyle.href=chrome.runtime.getURL("submission-settings.css");
document.head.append(settingsStyle);

chrome.cookies?.onChanged?.addListener(change=>{if(change.cookie.domain.replace(/^\./, "")==="waterlooworks.uwaterloo.ca")document.dispatchEvent(new Event("insider-account-changed"));});
chrome.storage.onChanged?.addListener((changes,area)=>{if(area==="local"&&changes["submission:settings"])document.dispatchEvent(new Event("insider-account-changed"));});
