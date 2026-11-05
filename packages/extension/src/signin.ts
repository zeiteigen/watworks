import { WATERLOOWORKS_JOBS_URL } from "../../shared/src/protocol.js";

const TAB_KEY = "signin:tab";
const EPISODE_KEY = "signin:episode-opened";

let opening: Promise<void> | undefined;

/** Coalesce simultaneous requests, and remember a successful launch across worker restarts. */
export function ensureSignIn(interactive = true): Promise<void> {
  if (!interactive) return Promise.resolve();
  if (opening) return opening;
  opening = openSignIn().finally(() => { opening = undefined; });
  return opening;
}

async function openSignIn(): Promise<void> {
  const episode = (await chrome.storage.session.get(EPISODE_KEY))[EPISODE_KEY] === true;
  if (episode) return;
  const tabs = await chrome.tabs.query({ url: "https://waterlooworks.uwaterloo.ca/*" });
  // Track the tab before navigation so even a fast SSO redirect sees the notice.
  const tab = tabs[0]?.id !== undefined ? tabs[0] : await chrome.tabs.create({ url: "about:blank", active: true });
  if (tab.id === undefined) throw new Error("Sign-in tab did not open");
  await chrome.storage.session.set({ [TAB_KEY]: tab.id });
  try { await chrome.tabs.update(tab.id, { url: WATERLOOWORKS_JOBS_URL, active: true }); }
  catch (error) { await chrome.storage.session.remove(TAB_KEY); throw error; }
  // Failed launches remain retryable on the next request.
  await chrome.storage.session.set({ [EPISODE_KEY]: true });
}

export async function clearSignInEpisode(): Promise<void> {
  await opening?.catch(() => undefined);
  const tabId = (await chrome.storage.session.get(TAB_KEY))[TAB_KEY];
  await chrome.storage.session.remove(TAB_KEY);
  await chrome.storage.session.remove(EPISODE_KEY);
  if (typeof tabId === "number") await chrome.tabs.sendMessage(tabId, {type:"pageSignInComplete"}).catch(() => undefined);
}

/** Call from an opt-in content script on the recognized WaterlooWorks sign-in form. */
export function continueRecognizedSignIn(documentRef: Document = document): boolean {
  const user = documentRef.querySelector<HTMLInputElement>('input[autocomplete="username"],input[name="username"],input[name="loginfmt"],input[type="email"]');
  const password = documentRef.querySelector<HTMLInputElement>('input[autocomplete="current-password"],input[type="password"]');
  const visible = (e: Element | null) => !!e && e.getClientRects().length > 0;
  if (visible(password) ? !password!.value.length : !visible(user) || !user!.value.length) return false;
  const button = [...documentRef.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input[type=submit]")].find((candidate) =>
    /^(sign in|log in|continue|next)$/i.test((candidate.getAttribute("value") ?? candidate.textContent ?? "").trim()));
  if (!button) return false;
  button.click();
  return true;
}

export async function isSignInTab(tabId: number): Promise<boolean> {
  return (await chrome.storage.session.get(TAB_KEY))[TAB_KEY] === tabId;
}
