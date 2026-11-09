import { getInsiderAccount } from "./insider-account.js";
import { developerModeEnabled, installDeveloperMode } from "./developer-mode.js";

installDeveloperMode(document);
document.addEventListener("submission-developer-mode-changed", () => void refresh());
const popupStatus = document.querySelector<HTMLElement>("#status")!;
async function refresh(): Promise<void> {
  const reply=await chrome.runtime.sendMessage({type:"status"});
  const health=reply?.value;
  popupStatus.textContent=health?.authenticated?"Signed in to WaterlooWorks.":"WaterlooWorks sign-in required.";
  const account = await getInsiderAccount().catch(() => null);
  const allowed = account?.insider || account?.selfHosted;
  const settingsLink = document.querySelector<HTMLElement>('[href="submission-settings.html"]');
  if (settingsLink) settingsLink.hidden = !allowed && !developerModeEnabled(document);
  const developer = developerModeEnabled(document);
  document.querySelector<HTMLElement>("#start-service")!.hidden = !developer;
  document.querySelector<HTMLElement>("#local-dashboard")!.hidden = !developer;
  if (!allowed) return;
  const inbox=await chrome.runtime.sendMessage({type:"discoveriesList"});
  const count=Array.isArray(inbox?.value)?inbox.value.length:0;
  popupStatus.textContent+=` ${count} saved discoveries.`;
}
document.querySelector("#workspace")!.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("hosted.html") }));
void refresh().catch(error=>{popupStatus.textContent=String(error);});

document.querySelector("#start-service")!.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#start-service")!;
  button.disabled = true;
  popupStatus.textContent = "Starting workspace service…";
  try {
    const reply = await chrome.runtime.sendMessage({ type: "startService" });
    if (!reply?.ok) throw new Error(reply?.error ?? "Workspace startup failed");
    popupStatus.textContent = "Workspace service is running. Open Dashboard to review your materials.";
  } catch (error) { popupStatus.textContent = String(error); }
  finally { button.disabled = false; }
});
