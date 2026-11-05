/** Manual application action shared by Core and Insider job cards. */
export const MANUAL_APPLY_SCRIPT = String.raw`
  const pendingManualApplications = new Map();
  const manualApplyLabel = 'Apply manually in WaterlooWorks ↗';
  function paintManualApplication(entry) {
    entry.button.disabled = true;
    entry.button.textContent = entry.remaining > 0 ? 'Core plan · Apply manually in WaterlooWorks (opens in ' + entry.remaining + 's)' : 'Opening WaterlooWorks…';
  }
  function manualApplyButton(job) {
    const manual = el('button', { class: 'secondary', type: 'button' }, manualApplyLabel);
    if (knownCore()) manual.title = 'Core includes a 5-second wait. Insider opens WaterlooWorks instantly and can apply automatically after your approval.';
    const pending = pendingManualApplications.get(job.key);
    if (pending) { pending.button = manual; paintManualApplication(pending); }
    manual.addEventListener('click', async () => {
      if (manual.disabled || pendingManualApplications.has(job.key)) return;
      const entry = { button: manual, remaining: 0, timer: undefined, opening: false };
      pendingManualApplications.set(job.key, entry);
      paintManualApplication(entry);
      const insider = insiderAccount ? insiderAccount.insider : await Promise.resolve(globalThis.hasInsiderAccount?.()).catch(() => false);
      if (pendingManualApplications.get(job.key) !== entry) return;
      const launch = async () => {
        if (entry.opening) return;
        entry.opening = true;
        paintManualApplication(entry);
        try { await openApplicationForm(job); }
        finally {
          pendingManualApplications.delete(job.key);
          entry.button.disabled = false;
          entry.button.textContent = manualApplyLabel;
        }
      };
      if (insider) { await launch(); return; }
      entry.remaining = 5;
      paintManualApplication(entry);
      entry.timer = setInterval(() => {
        if (pendingManualApplications.get(job.key) !== entry) return;
        entry.remaining -= 1;
        paintManualApplication(entry);
        if (entry.remaining <= 0) { clearInterval(entry.timer); void launch(); }
      }, 1000);
    });
    return manual;
  }
  globalThis.addEventListener?.('pagehide', () => {
    for (const entry of pendingManualApplications.values()) clearInterval(entry.timer);
    pendingManualApplications.clear();
  });
`;
