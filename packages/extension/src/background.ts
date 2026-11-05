import { getSubmissionStatus, markSubmissionSessionDirty, prepareSubmissionSession } from "./submission-client.js";
import { refreshDueDiscovery } from "./discovery-session.js";
import { startService } from "./start-service.js";
import { openApplicationForm } from "./open-application-form.js";
import { diagnosticTabs, inspectTab } from "./tab-inspection.js";
import { EXTENSION_BUILD } from "./build-info.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import { daily, reads, executeCommand } from "./commands.js";
import { discoveryStatus, discoveriesList } from "./discovery.js";
import { policyGet, policySave } from "./discovery-policy.js";
import { connect, serviceConnected } from "./connection.js";
import { browserResearch } from "./research.js";
import { handlePageMessage } from "./page-messages.js";
import { clearSignInEpisode, isSignInTab, continueRecognizedSignIn, ensureSignIn } from "./signin.js";

chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  const pageTask = handlePageMessage(message, sender);
  if (pageTask) {
    void pageTask.then(value => reply({ok:true,value}), () => reply({ok:false,error:"Page request failed"}));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const input = message as { type?: string; policy?: unknown; tabId?: unknown; includeHtml?: unknown; jobId?: unknown };
  const task = async () => {
    if (input.type === "openApplicationForm") return openApplicationForm(input.jobId, reads);
    if(input.type === "debugListTabs")return diagnosticTabs();
    if(input.type === "debugInspectTab")return {extensionBuild:EXTENSION_BUILD,...await inspectTab(input.tabId,input.includeHtml)};
    if (input.type === "startService") { await startService(); connect(); return { started: true }; }
    if (input.type === "signIn") {
      await chrome.storage.session.remove("signin:episode-opened");
      await ensureSignIn();
      return { ok: true };
    }
    if (input.type === "listApplications") return executeCommand("listApplications",[],Date.now()+30_000);
    if (input.type === "getSubmissionStatus") return getSubmissionStatus();
    if (input.type === "prepareSubmissionSession") return prepareSubmissionSession();
    if (input.type === "status") return { ...await browserResearch.health(), serviceConnected: serviceConnected() };
    if (input.type === "checkNow") return daily(true);
    if (input.type === "discoveryPolicyGet") return policyGet();
    if (input.type === "discoveryPolicySave") return policySave(input.policy);
    if (input.type === "discoveryStatus") return discoveryStatus();
    if (input.type === "discoveriesList") return discoveriesList();
    throw new Error("Unsupported extension message");
  };
  void task().then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error instanceof Error ? error.message : "Extension failed" }));
  return true;
});

async function lifecycle() {
  connect();
  await chrome.alarms.create("workspace-reconnect", { periodInMinutes: 1 });
  await chrome.alarms.clear("daily-discovery");
  await chrome.alarms.clear("submission-session-refresh");
  await chrome.alarms.create("discovery-session-demand", { periodInMinutes: 1 });
  void refreshDueDiscovery().catch(() => undefined);
}

chrome.runtime.onStartup.addListener(() => { void lifecycle(); });
chrome.runtime.onInstalled.addListener(() => { void lifecycle(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "workspace-reconnect") connect();
  if (alarm.name === "discovery-session-demand") void refreshDueDiscovery().catch(() => undefined);
});
chrome.notifications.onClicked.addListener(() => { void chrome.tabs.create({ url: chrome.runtime.getURL("inbox.html") }); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== "complete" || !tab.url) return;
  const url = new URL(tab.url);
  if (url.origin === WATERLOOWORKS_ORIGIN) {
    void browserResearch.health().then(async health => {
      if (health.authenticated) {
        await clearSignInEpisode();
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

void lifecycle();

// Record browser sign-in changes without exporting cookies from this event handler.
chrome.cookies.onChanged.addListener(({cookie})=>{
  if(cookie.domain.replace(/^\./,"")==="waterlooworks.uwaterloo.ca")void markSubmissionSessionDirty().catch(()=>{});
});
