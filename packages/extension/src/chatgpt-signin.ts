import { hostedRequest } from "./hosted-client.js";

const PENDING_KEY = "hosted:chatgpt-signin";
const AUTH_ORIGIN = "https://auth.openai.com";
/** Optional host permission for the local OAuth callback tab; requested when the user clicks Connect. */
export const CHATGPT_CALLBACK_PERMISSION = "http://127.0.0.1/*";
const CALLBACK_PERMISSION_DENIED = "ChatGPT sign-in returns to a local address (127.0.0.1) that WatWorks needs permission to read. Allow it to connect ChatGPT, or add an API key instead.";

type ConnectApi = {
  permissions: { request(permissions: { origins: string[] }): Promise<boolean> };
  runtime: { sendMessage(message: { type: "chatgptSignIn" }): Promise<{ ok?: boolean; error?: string } | undefined> };
};
/**
 * Call synchronously from the Connect click: Chrome shows the optional-permission prompt only
 * inside a user gesture, so the request is made before anything is awaited.
 */
export function beginChatGptConnect(api: ConnectApi = chrome as unknown as ConnectApi): Promise<void> {
  const permission = api.permissions.request({ origins: [CHATGPT_CALLBACK_PERMISSION] });
  return (async () => {
    if (!await permission) throw new Error(CALLBACK_PERMISSION_DENIED);
    const reply = await api.runtime.sendMessage({ type: "chatgptSignIn" });
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not start ChatGPT sign-in.");
  })();
}
const AUTH_PATH = "/api/accounts/authorize";
const ATTEMPT_LIFETIME = 10 * 60_000;
let completingAttempt: string | undefined;
interface PendingAttempt { tabId: number; attemptId: string; callbackUri: string; expiresAt: number }
interface StartResponse { authorizationUrl: string; callbackUri: string; attemptId: string }

async function trustedStorage(): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
async function readPending(): Promise<PendingAttempt | undefined> {
  await trustedStorage();
  return (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as PendingAttempt | undefined;
}
async function writePending(attempt: PendingAttempt): Promise<void> {
  await trustedStorage();
  await chrome.storage.session.set({ [PENDING_KEY]: attempt });
}
async function clearPending(): Promise<void> {
  await trustedStorage();
  await chrome.storage.session.remove(PENDING_KEY);
}

export function isChatGptCallback(tabId: number, urlText: string, pending: PendingAttempt): boolean {
  if (tabId !== pending.tabId || pending.expiresAt <= Date.now()) return false;
  try {
    const actual = new URL(urlText), expected = new URL(pending.callbackUri);
    return expected.protocol === "http:" && expected.pathname === "/auth/callback" &&
      actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch { return false; }
}

export async function startChatGptSignIn(): Promise<{ started: true }> {
  const pending = await readPending();
  if (pending && pending.expiresAt > Date.now()) throw new Error("A ChatGPT connection is already in progress.");
  if (pending) await clearPending();
  // Without it the callback tab's address is hidden and the attempt could never finish.
  if (!await chrome.permissions.contains({ origins: [CHATGPT_CALLBACK_PERMISSION] }))
    throw new Error(CALLBACK_PERMISSION_DENIED);
  const result = await hostedRequest<StartResponse>("/chatgpt/start", { method: "POST", body: "{}" });
  const authorization = new URL(result.authorizationUrl);
  if (authorization.origin !== AUTH_ORIGIN || authorization.pathname !== AUTH_PATH || authorization.username || authorization.password || authorization.hash)
    throw new Error("The hosted service returned an invalid ChatGPT authorization URL.");
  const callback = new URL(result.callbackUri);
  if (callback.href !== "http://127.0.0.1:1455/auth/callback" || !result.attemptId)
    throw new Error("The hosted service returned an invalid ChatGPT callback.");
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  if (tab.id === undefined) throw new Error("Could not open the ChatGPT authorization tab.");
  await writePending({ tabId: tab.id, attemptId: result.attemptId, callbackUri: callback.href, expiresAt: Date.now() + ATTEMPT_LIFETIME });
  try { await chrome.tabs.update(tab.id, { url: authorization.href }); }
  catch (error) { await clearPending(); await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  return { started: true };
}

export async function observeChatGptTab(tabId: number, url?: string): Promise<void> {
  if (!url) return;
  const pending = await readPending();
  if (!pending) return;
  if (pending.expiresAt <= Date.now()) {
    await clearPending();
    await chrome.tabs.remove(pending.tabId).catch(() => {});
    return;
  }
  if (!isChatGptCallback(tabId, url, pending)) return;
  if (completingAttempt === pending.attemptId) return;
  completingAttempt = pending.attemptId;
  // Consume before network work so an update event cannot replay the callback.
  await clearPending();
  try {
    const result = await hostedRequest<{ connected: true; email: string }>("/chatgpt/complete", {
      method: "POST", body: JSON.stringify({ attemptId: pending.attemptId, callbackUrl: url }),
    });
    await chrome.runtime.sendMessage({ type: "chatgptSignInComplete", connected: result.connected, email: result.email }).catch(() => {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ChatGPT connection failed.";
    await chrome.runtime.sendMessage({ type: "chatgptSignInComplete", connected: false, error: reason }).catch(() => {});
  } finally {
    await chrome.tabs.remove(pending.tabId).catch(() => {});
    completingAttempt = undefined;
  }
}

export async function clearChatGptAttemptForClosedTab(tabId: number): Promise<void> {
  const pending = await readPending();
  if (pending?.tabId === tabId) await clearPending();
}
