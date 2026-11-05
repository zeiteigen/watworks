import { createSubmissionSettingsPanel } from "./submission-settings-panel.js";
import { getInsiderAccount } from "./insider-account.js";
import { developerModeEnabled, installDeveloperMode } from "./developer-mode.js";

installDeveloperMode(document);
document.addEventListener("submission-developer-mode-changed", () => void render());

async function render(): Promise<void> {
  const account = await getInsiderAccount();
  const main = document.querySelector("main")!;
  main.replaceChildren();
  if (account.insider || account.selfHosted || developerModeEnabled(document)) main.append(createSubmissionSettingsPanel());
  else main.textContent = "No settings available for your plan.";
}
void render();
