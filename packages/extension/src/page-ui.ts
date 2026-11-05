/** Isolated styles keep WaterlooWorks and SSO CSS out of the extension controls. */
export function mountDashboardButton(documentRef: Document, open: () => Promise<void>): void {
  const name = documentRef.querySelector<HTMLElement>('#myAccountNav .user-box > span');
  if (!name || name.querySelector('[data-watworks-dashboard]')) return;
  const label = documentRef.createElement('span');
  label.style.cssText = 'min-width:0;font-size:14px;line-height:1.4;font-weight:600;overflow-wrap:anywhere';
  while (name.firstChild) label.append(name.firstChild);
  name.append(label);
  name.style.setProperty('display', 'grid', 'important');
  name.style.gridTemplateColumns = 'minmax(0, 1fr) minmax(0, 1fr)';
  name.style.gap = '8px';
  name.style.alignItems = 'center';
  const accountBox = name.parentElement as HTMLElement;
  accountBox.style.setProperty('padding-left', '8px', 'important');
  accountBox.style.setProperty('padding-right', '8px', 'important');
  const host = documentRef.createElement('span');
  host.dataset.watworksDashboard = '';
  host.style.cssText = 'display:block;min-width:0;width:100%;line-height:1';
  const shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = `<style>
    :host{font:13px/1.4 system-ui,sans-serif}button{font:inherit;color:#fff;background:#24674d;border:1px solid #8bc1a5;border-radius:6px;padding:6px 4px;width:100%;min-height:44px;display:block;text-align:center;cursor:pointer;box-sizing:border-box}
    button span{display:block;font-size:11px;line-height:1.3}button strong{display:block;font-size:13px;line-height:1.4}
    button:hover{background:#185039}button:focus-visible{outline:3px solid #ffd75e;outline-offset:3px}
    p{font:12px/1.4 system-ui,sans-serif;color:#fff;margin:4px 0}
  </style><button type="button" aria-label="Open WatWorks dashboard" title="Open WatWorks dashboard (new tab)"><span>WatWorks</span><strong>Dashboard ↗</strong></button><p role="status" hidden></p>`;
  shadow.querySelector('button')!.addEventListener('click', () => {
    void open().catch(() => {
      const status = shadow.querySelector('p')!;
      status.hidden = false;
      status.textContent = 'Could not open WatWorks. Reload this page and try again.';
    });
  });
  name.append(host);
}

export function mountSignInNotice(documentRef: Document): () => void {
  const host = documentRef.createElement('aside');
  host.dataset.watworksSignin = '';
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;width:min(360px,calc(100vw - 40px))';
  const shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = `<style>
    :host{font:14px/1.5 system-ui,sans-serif;color:#193c2e}section{position:relative;box-sizing:border-box;background:#f5fff8;border:1px solid #81b79b;border-radius:12px;box-shadow:0 6px 28px #0003;padding:18px 40px 18px 18px}
    strong{display:block;font-size:16px;margin-bottom:6px}p{margin:0}button{position:absolute;top:8px;right:8px;background:transparent;border:0;font:22px system-ui;cursor:pointer;color:#193c2e}button:focus-visible{outline:3px solid #24674d}
  </style><section role="status"><strong>Sign in for WatWorks</strong><p>WatWorks opened this tab to connect your WaterlooWorks session. Complete your usual university sign-in here, then return to WatWorks.</p><button type="button" aria-label="Dismiss WatWorks sign-in notice">×</button></section>`;
  shadow.querySelector('button')!.addEventListener('click', () => host.remove());
  documentRef.body.append(host);
  return () => host.remove();
}
