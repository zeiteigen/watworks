import { refreshHostedDemand } from './hosted-demand.js';
import { prepareHostedSubmissionSession } from './hosted-session.js';
import { getHostedAccount } from './insider-account.js';
import { openApplicationForm, openPosting } from "./open-application-form.js";
import { diagnosticTabs, inspectTab } from "./tab-inspection.js";
import { EXTENSION_BUILD } from "./build-info.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import { browserFetch, browserResearch } from "./research.js";
import { BrowserApplicationReads } from "./application-reads.js";
import { handlePageMessage } from "./page-messages.js";
import { clearSignInEpisode, isSignInTab, continueRecognizedSignIn, ensureSignIn } from "./signin.js";
import { clearChatGptAttemptForClosedTab, observeChatGptTab, startChatGptSignIn } from "./chatgpt-signin.js";

const reads = new BrowserApplicationReads(browserFetch);
// Name kept from before so an installed extension does not leave a duplicate alarm behind.
const HOSTED_DEMAND_ALARM = "discovery-session-demand";

chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  const pageTask = handlePageMessage(message, sender);
  if (pageTask) {
    void pageTask.then(value => reply({ok:true,value}), () => reply({ok:false,error:"Page request failed"}));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const input = message as { type?: string; tabId?: unknown; includeHtml?: unknown; jobId?: unknown };
  const task = async () => {
    if (input.type === "openApplicationForm") return openApplicationForm(input.jobId, reads);
    if (input.type === "openPosting") return openPosting(input.jobId);
    if(input.type === "debugListTabs")return diagnosticTabs();
    if(input.type === "debugInspectTab")return {extensionBuild:EXTENSION_BUILD,...await inspectTab(input.tabId,input.includeHtml)};
    if (input.type === "signIn") {
      await chrome.storage.session.remove("signin:episode-opened");
      await ensureSignIn();
      return { ok: true };
    }
    if (input.type === "chatgptSignIn") return startChatGptSignIn();
    if (input.type === "chatgptSignInComplete") return { received: true };
    if (input.type === "getHostedAccount") return getHostedAccount();
    if (input.type === "prepareHostedSubmissionSession") { await prepareHostedSubmissionSession(); return { prepared: true }; }
    if (input.type === "status") return browserResearch.health();
    throw new Error("Unsupported extension message");
  };
  void task().then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error instanceof Error ? error.message : "Extension failed" }));
  return true;
});

async function lifecycle() {
  // Alarms and settings left behind by the removed local workspace mode.
  await Promise.all(["workspace-reconnect", "daily-discovery", "submission-session-refresh"].map(name => chrome.alarms.clear(name)));
  await chrome.storage.local.remove("workspace:local-mode");
  await chrome.alarms.create(HOSTED_DEMAND_ALARM, { periodInMinutes: 1 });
  void refreshHostedDemand().catch(() => undefined);
}

chrome.runtime.onStartup.addListener(() => { void lifecycle(); });
chrome.runtime.onInstalled.addListener(() => { void lifecycle(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === HOSTED_DEMAND_ALARM) void refreshHostedDemand().catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  void observeChatGptTab(tabId, change.url ?? tab.url).catch(() => undefined);
  if (change.status !== "complete" || !tab.url) return;
  const url = new URL(tab.url);
  if (url.origin === WATERLOOWORKS_ORIGIN) {
    void browserResearch.health().then(async health => {
      if (health.authenticated) {
        await clearSignInEpisode();
        // An open workspace page connects itself; no receiver just means none is open.
        await chrome.runtime.sendMessage({ type: "waterlooWorksSignedIn" }).catch(() => undefined);
      }
    });
  }
  const supported = [WATERLOOWORKS_ORIGIN, "https://adfs.uwaterloo.ca", "https://sts.uwaterloo.ca"];
  if (supported.includes(url.origin)) {
    void isSignInTab(tabId).then(async signingIn => signingIn && await chrome.permissions.contains({ origins: [`${url.origin}/*`] }))
      .then(allowed => allowed ? chrome.scripting.executeScript({ target: { tabId }, func: continueRecognizedSignIn }) : undefined)
      .catch(() => undefined);
  }
});
chrome.tabs.onRemoved.addListener(tabId => { void clearChatGptAttemptForClosedTab(tabId).catch(() => undefined); });

void lifecycle();

