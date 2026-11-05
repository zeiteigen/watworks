import { WATERLOOWORKS_ORIGIN } from '../../shared/src/protocol.js';
import { isSignInTab } from './signin.js';

export const SIGN_IN_ORIGINS = [WATERLOOWORKS_ORIGIN, 'https://adfs.uwaterloo.ca', 'https://sts.uwaterloo.ca'];

/** Content scripts receive only these two capabilities, never the extension-page API. */
export function handlePageMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> | undefined {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined) return;
  let origin: string;
  try { origin = new URL(sender.url ?? '').origin; } catch { return; }
  if (!message || typeof message !== 'object') return;
  const type = (message as {type?:unknown}).type;
  if (type === 'pageSignInContext' && SIGN_IN_ORIGINS.includes(origin)) {
    return isSignInTab(sender.tab.id).then(signingIn => ({signingIn}));
  }
  if (type === 'pageOpenDashboard' && origin === WATERLOOWORKS_ORIGIN) {
    return chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')}).then(() => ({opened:true}));
  }
}
