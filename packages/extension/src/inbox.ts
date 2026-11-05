import { WATERLOOWORKS_JOBS_URL } from "../../shared/src/protocol.js";
import type { DiscoveryPolicy } from "./discovery-policy.js";
import type { DiscoveryResult } from "./discovery.js";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const input = (selector: string): HTMLInputElement => document.querySelector<HTMLInputElement>(selector)!;
const message = $("#message");
let policy: DiscoveryPolicy;
let results: DiscoveryResult[] = [];

function renderRules(): void {
  const list = $("#rules");
  list.replaceChildren();
  if (!policy.rules.length) {
    const empty = document.createElement("li");
    empty.textContent = "No matching rules are configured yet.";
    list.append(empty);
    return;
  }
  for (const rule of policy.rules) {
    const item = document.createElement("li");
    item.textContent = `${rule.field}: “${rule.phrase}” (${rule.weight >= 0 ? "+" : ""}${rule.weight})`;
    list.append(item);
  }
}

function renderResults(): void {
  const list = $("#results");
  list.replaceChildren();
  if (!results.length) {
    const empty = document.createElement("li");
    empty.textContent = "No saved matches yet.";
    list.append(empty);
    return;
  }
  for (const result of results) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = result.title ?? `Posting ${result.id}`;
    const detail = document.createElement("p");
    detail.textContent = [result.employer, result.location, `Score ${result.score}`, result.reasons.join("; ")].filter(Boolean).join(" · ");
    const link = document.createElement("a");
    link.href = WATERLOOWORKS_JOBS_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open WaterlooWorks jobs";
    const id = document.createElement("p");
    id.textContent = `Posting ID: ${result.id}`;
    item.append(title, detail, link, id);
    list.append(item);
  }
}

async function send<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ type, ...extra });
  if (!reply?.ok) throw new Error(reply?.error ?? "Extension request failed");
  return reply.value as T;
}

async function load(): Promise<void> {
  try {
    [policy, results] = await Promise.all([send<DiscoveryPolicy>("discoveryPolicyGet"), send<DiscoveryResult[]>("discoveriesList")]);
    input("#enabled").checked = policy.enabled;
    input("#hour").value = String(policy.hour);
    input("#threshold").value = String(policy.threshold);
    renderRules();
    renderResults();
  } catch (error) { message.textContent = String(error); }
}

$("#save").addEventListener("click", async () => {
  try {
    policy = await send<DiscoveryPolicy>("discoveryPolicySave", { policy: {
      ...policy,
      enabled: input("#enabled").checked,
      hour: Number(input("#hour").value),
      threshold: Number(input("#threshold").value),
    } });
    message.textContent = "Settings saved.";
  } catch (error) { message.textContent = `Could not save: ${String(error)}`; }
});

$("#check").addEventListener("click", async () => {
  try {
    const result = await send<{ added: number; errors: number }>("checkNow");
    const status = await send<{error?:string}>("discoveryStatus");
    message.textContent = status.error ?? `Saved ${result.added} matches; ${result.errors} posting errors.`;
    await load();
  } catch (error) { message.textContent = String(error); }
});

$("#copy").addEventListener("click", async () => {
  const lines = results.map((item) => `- ${item.title ?? "Posting"} (WaterlooWorks ID: ${item.id}) — ${item.employer ?? ""}; score ${item.score}; ${item.reasons.join(", ")}`);
  const prompt = `Review these WaterlooWorks postings using read-only research tools. Do not apply or submit anything without my decision.\n${lines.join("\n")}`;
  await navigator.clipboard.writeText(prompt);
  message.textContent = "Agent prompt copied.";
});

void load();
