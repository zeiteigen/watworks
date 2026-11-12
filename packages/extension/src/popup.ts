import { installDeveloperMode } from "./developer-mode.js";

// Typing the shortcut reveals the tab diagnostics link.
installDeveloperMode(document);
const popupStatus = document.querySelector<HTMLElement>("#status")!;
async function refresh(): Promise<void> {
  const reply=await chrome.runtime.sendMessage({type:"status"});
  const health=reply?.value;
  popupStatus.textContent=health?.authenticated?"Signed in to WaterlooWorks.":"WaterlooWorks sign-in required.";
}
document.querySelector("#workspace")!.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("hosted.html") }));
void refresh().catch(error=>{popupStatus.textContent=String(error);});

