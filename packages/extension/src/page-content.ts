import { mountDashboardButton, mountSignInNotice } from './page-ui.js';

// This script never reads credentials, form values, or extension storage.
if (window === window.top) {
  const waterlooWorks = location.origin === 'https://waterlooworks.uwaterloo.ca';
  if (waterlooWorks) {
    const mount = () => mountDashboardButton(document, async () => {
      const reply = await chrome.runtime.sendMessage({type:'pageOpenDashboard'});
      if (!reply?.ok) throw new Error('Dashboard unavailable');
    });
    mount();
    new MutationObserver(mount).observe(document.body, {childList:true,subtree:true});
  }
  let removeNotice: (() => void) | undefined;
  let completed = false;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'pageSignInComplete') { completed = true; removeNotice?.(); }
  });
  void chrome.runtime.sendMessage({type:'pageSignInContext'}).then(reply => {
    if (reply?.ok && reply.value?.signingIn && !completed) removeNotice = mountSignInNotice(document);
  }).catch(() => undefined);
}
