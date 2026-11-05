import { APPLICATION_APPROVAL_SCRIPT } from "./application-approval-ui.js";
import { APPLICATION_STATUS_SCRIPT } from "./application-status.js";
import { RECOVERY_UI_SCRIPT } from "./recovery-ui.js";
import { POSTING_CONTENT_SCRIPT } from "./posting-content.js";
import { MANUAL_APPLY_SCRIPT } from "./manual-apply-ui.js";
import { DOCUMENT_PREVIEW_SCRIPT } from "./document-preview.js";

/** Browser-only UI. The server enforces every rule; this script only renders and forwards clicks. */
export const DASHBOARD_SCRIPT = String.raw`
(() => {
  const $ = id => document.getElementById(id);
  const selected = new Set();
  const open = new Set();
  let jobs = [];
  let timer;
  let applicationEvents;
  function stopApplicationEvents(){if(applicationEvents){applicationEvents.close();applicationEvents=undefined;}}
  function watchApplications(){
    if(applicationEvents)return;
    const stream=new EventSource(globalThis.dashboardEventsUrl || '/api/application-events');
    applicationEvents=stream;
    stream.onmessage=event=>{
      try{
        const update=JSON.parse(event.data);
        if(!Array.isArray(update.jobs))throw new Error('Invalid application update');
        const patches=new Map(update.jobs.map(job=>[job.key,job]));
        const previousApproval = approvalSelection();
        jobs=jobs.map(job=>{const patch=patches.get(job.key);return patch?{...job,status:patch.status,active:patch.active}:job;});
        if(previousApproval !== approvalSelection()) armed=false;
        snapshot='';render();
        const active=jobs.find(job=>job.status.state==='applying');
        if(active)$('status').textContent=active.status.reason || 'Applying…';
        if(!jobs.some(job=>job.active || job.status.state==='applying')){stopApplicationEvents();void load();}
      }catch{stopApplicationEvents();notice('Application updates disconnected. Refresh to check the original operation.');}
    };
    stream.onerror=()=>{
      // Reconnect only the read-only view. Never replay an Apply request.
      stopApplicationEvents();
      notice('Application updates disconnected. Reconnecting…');
      timer=setTimeout(load,5000);
    };
  }
  globalThis.addEventListener?.('pagehide',stopApplicationEvents);
  let armed = false;
  let preparing = false;
  let dispatching = false;
  let submissionReady = false;
  const pendingApplications = new Map();
  let snapshot = '';
  let activeTab = 'jobs';
  let queueView = 'queue';
  let queueTab = 'ready';
  let search = '';
  let materialsFailed = false;
  let blockSnapshot = '';
  let submissionBlocked = false;
  let insiderAccount = null;
  async function refreshAccount() {
    if (!globalThis.getInsiderAccount) return;
    try {
      insiderAccount = await globalThis.getInsiderAccount();
      $('account-plan').replaceChildren(el('span', { class: 'plan-label' }, insiderAccount.insider ? 'Insider' : 'Core'),
        el('span', { class: 'meta' }, [insiderAccount.email || 'No WaterlooWorks account signed in', insiderAccount.term, insiderAccount.reason].filter(Boolean).join(' · ')));
      $('insider-nudge').hidden = canSubmit();
      if (!canSubmit()) { selected.clear(); armed = false; }
      document.querySelector('.lede').textContent = canSubmit() ? 'Review your documents and answers, then apply. Each application needs your approval.' : 'Review your documents and answers, then apply manually in WaterlooWorks.'
      updateBar();
    } catch { insiderAccount = null; $('insider-nudge').hidden = false; $('account-plan').replaceChildren(el('span', { class: 'plan-label' }, 'Core'), el('span', { class: 'meta' }, 'WaterlooWorks account status unavailable')); }
  }
  const canSubmit = () => !globalThis.getInsiderAccount || Boolean(insiderAccount?.insider || insiderAccount?.selfHosted);
  const knownCore = () => !canSubmit();
  const inQueue = job => !job.status.removedFromQueueAt && job.status.state !== 'skipped';
  let statusNotice;
  function notice(message) { statusNotice = { message, until: Date.now() + 20000 }; $('status').textContent = message; }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  async function api(path, body) {
    if (globalThis.dashboardRequest) return globalThis.dashboardRequest(path, body);
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.headers.get('content-type')?.startsWith('application/pdf')) return response.blob();
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Request refused');
    return data;
  }

  const jobPath = key => '/api/jobs/' + key.split(':').map(encodeURIComponent).join('/');
  const materialPath = (key, id) => '/api/materials/jobs/' + key.split(':').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(id);
  const labels = { ready: 'Ready', planned: 'Needs attention', found: 'Not planned', applying: 'Applying…', confirm_required: 'Confirm documents', applied: 'Applied', form_filled: 'Applied · checking submission', failed: 'Needs attention', outcome_unknown: 'Check submission', skipped: 'Removed' };

${POSTING_CONTENT_SCRIPT}
${DOCUMENT_PREVIEW_SCRIPT}
${MANUAL_APPLY_SCRIPT}
${APPLICATION_STATUS_SCRIPT}

  async function renderDetails(job, box) {
    box.replaceChildren(el('p', { class: 'meta' }, 'Loading details…'));
    try {
      const detail = await api(jobPath(job.key));
      const docs = el('div', { class: 'actions' });
      if (job.resumeVariant) docs.append(el('button', { class: 'secondary', type: 'button', onclick: () => preview(jobPath(job.key) + '/files/resume', 'Resume · ' + job.summary.title) }, 'View resume (' + job.resumeVariant + ')'));
      for (const doc of job.documents) {
        const file = doc.kind === 'cover_letter' ? 'cover-letter' : 'doc-' + doc.id;
        docs.append(el('button', { class: 'secondary', type: 'button', onclick: () => preview(jobPath(job.key) + '/files/' + file, doc.title || 'Cover letter') }, 'View ' + (doc.kind === 'cover_letter' ? 'cover letter' : doc.title)));
      }
      for (const doc of job.confirmation?.documents || []) docs.append(el('button', { class: 'secondary', type: 'button', onclick: () => preview(jobPath(job.key) + '/files/processed-' + doc.id, 'Processed: ' + doc.name) }, 'View processed: ' + doc.name));
      box.replaceChildren(
        el('section', { class: 'detail-materials', 'aria-label': 'Application documents' },
          el('h3', {}, 'Your documents'), docs.childNodes.length ? docs : el('p', { class: 'meta' }, 'No documents prepared yet. Ask your agent to prepare this application.')),
        el('h3', {}, 'Required documents'),
        detail.requirements?.length ? el('ul', {}, detail.requirements.map(r => el('li', {}, r.label + (r.required ? ' (required)' : ' (optional)'))))
          : (detail.postingRequiredDocuments || job.summary.requiredDocuments || []).length
            ? el('div', {}, el('ul', {}, (detail.postingRequiredDocuments || job.summary.requiredDocuments).map(label => el('li', {}, label))), el('p', { class: 'meta' }, 'From the posting. Confirm the document slots in WaterlooWorks.'))
            : el('p', { class: 'meta' }, 'Document requirements unavailable. Check the full posting or WaterlooWorks.'),
        el('h3', {}, 'Screening questions'),
        detail.questions === null ? el('p', { class: 'meta' }, 'Screening questions unavailable. Verify in WaterlooWorks.')
          : (detail.questions || []).length ? el('ul', {}, detail.questions.map(q => el('li', {}, q.label + (q.required ? ' (required)' : ' (optional)'),
            q.options?.length ? el('p', { class: 'meta' }, 'Options: ' + q.options.map(o => o.label).join(' · ')) : null)))
          : el('p', { class: 'meta' }, 'No screening questions.'),
        detail.formBlockers?.length ? el('ul', { class: 'blockers' }, detail.formBlockers.map(b => el('li', {}, b))) : '',
        el('h3', {}, 'Your application materials and answers'),
        detail.answers.length ? el('table', {}, el('tbody', {}, detail.answers.map(a => el('tr', {}, el('th', {}, a.question), el('td', {}, a.answer))))) : el('p', { class: 'meta' }, 'No screening answers prepared.'),
        detail.attachments.length ? el('p', { class: 'meta' }, 'Attachments: ' + detail.attachments.map(a => a.label + (a.kind === 'cover_letter' ? ' (cover letter)' : a.kind === 'document' ? ' (generated)' : '')).join(', ')) : '',
        detail.externalSteps.length ? el('ul', { class: 'caveats' }, detail.externalSteps.map(step => el('li', {}, 'After applying: ' + step))) : '',
        el('section', { class: 'posting-content' }, el('h3', {}, 'Full posting'),
          el('p', { class: 'meta' }, 'Posting ' + job.summary.jobId + ' · ' + job.summary.employer),
          renderPosting(detail.description || 'No posting description was saved.', el)),
      );
    } catch (error) { box.replaceChildren(el('p', { class: 'blockers' }, error.message)); }
  }

  async function act(job, action, body) {
    try {
      await api(jobPath(job.key) + '/' + action, body || {});
      if (action === 'remove') { selected.delete(job.key); open.delete(job.key); armed = false; }
      await load();
      if (action === 'remove') notice('Removed ' + job.summary.title + '. Find it under Removed jobs to restore it.');
    } catch (error) { notice(error.message); }
  }

  async function openApplicationForm(job) {
    try {
      notice('Opening application form for posting ' + job.summary.jobId + ' in WaterlooWorks…');
      await api(jobPath(job.key) + '/open-application-form', {});
      notice('Opened application form for posting ' + job.summary.jobId + ' in WaterlooWorks.');
    } catch (error) { notice(error.message); }
  }

  function card(job) {
    const s = job.summary;
    const pendingReason = pendingApplications.get(job.key);
    const state = pendingReason || job.active ? 'applying' : job.status.state;
    const selectable = canSubmit() && inQueue(job) && !job.active && state === 'ready';
    const details = el('div', { class: 'details', hidden: !open.has(job.key) });
    if (open.has(job.key)) renderDetails(job, details);
    const toggle = el('button', { class: 'secondary', type: 'button', 'aria-expanded': String(open.has(job.key)), onclick: () => {
      if (open.has(job.key)) { open.delete(job.key); details.hidden = true; }
      else { open.add(job.key); details.hidden = false; renderDetails(job, details); }
      toggle.setAttribute('aria-expanded', String(open.has(job.key)));
      toggle.textContent = open.has(job.key) ? 'Hide details' : 'View in detail';
    } }, open.has(job.key) ? 'Hide details' : 'View in detail');
    const actions = el('div', { class: 'actions' }, toggle);
    if (knownCore()) actions.append(el('button', { class: 'secondary', type: 'button', disabled: true, title: 'Reserved for Insiders', 'aria-label': 'Auto-apply — requires Insider' }, 'Auto-apply'));
    if (inQueue(job) && job.manualApply && !job.active && ['ready', 'planned', 'found'].includes(state)) actions.append(manualApplyButton(job));
      if (canSubmit() && inQueue(job) && state === 'confirm_required' && job.confirmation) actions.append(el('button', { type: 'button', disabled: Boolean(knownCore()), title: knownCore() ? 'Insider is required for server applications.' : undefined, onclick: () => act(job, 'confirm', { manifestHash: job.confirmation.manifestHash }) }, job.confirmation.fillOnly ? 'Confirm and fill form' : 'Confirm and submit'));
    if (inQueue(job) && !job.active && ['failed', 'outcome_unknown'].includes(state)) {
      actions.append(el('button', { type: 'button', onclick: () => showRecovery(job) }, 'Resolve application'));
    } else if (inQueue(job) && job.manualApply && ['planned', 'found'].includes(state)) {
      actions.append(el('button', { class: 'secondary', type: 'button', onclick: () => showRecovery(job) }, 'Check preparation'));
    }
    if (!job.active && (!inQueue(job) || ['ready', 'planned', 'found', 'failed', 'skipped'].includes(state))) actions.append(el('button', { class: 'secondary remove-action', type: 'button', onclick: () => act(job, inQueue(job) ? 'remove' : 'requeue') }, inQueue(job) ? 'Remove from queue' : 'Restore to queue'));
    const check = selectable && job.approvalHash ? el('input', { type: 'checkbox', checked: selected.has(job.key), 'aria-label': 'Select ' + s.title, onchange: e => { armed = false; e.target.checked ? selected.add(job.key) : selected.delete(job.key); updateBar(); } }) : el('span');
    return el('article', { class: 'card' },
      el('div', { class: 'row' }, check,
        el('div', {},
          el('p', { class: 'job-title' }, s.title),
          el('p', { class: 'meta' }, [s.employer, s.location, s.term, s.compensation, s.deadline && 'Deadline ' + s.deadline].filter(Boolean).join(' · ')),
          job.fit ? el('p', { class: 'fit' }, job.fit) : null,
          job.caveats.length ? el('ul', { class: 'caveats' }, job.caveats.map(c => el('li', {}, c))) : null,
          (job.status.reason || pendingReason) ? el('p', { class: state === 'applying' ? 'phase' : 'meta', ...(state === 'applying' ? { role: 'status', 'aria-live': 'polite' } : {}) }, job.status.state === 'applying' ? job.status.reason || pendingReason : pendingReason || job.status.reason) : null,
          job.status.blockers.length ? el('ul', { class: 'blockers' }, job.status.blockers.map(b => el('li', {}, b))) : null,
          job.status.state === 'applied' && job.status.externalSteps.length ? el('ul', { class: 'caveats' }, job.status.externalSteps.map(step => el('li', {}, 'Still to do: ' + step))) : null,
        ),
        el('span', { class: 'state ' + state }, labels[state] || state)),
      el('div', { class: 'job-footer' }, el('span', { class: 'posting-id' }, 'Posting ' + s.jobId), actions), details);
  }

  const groups = [
    ['progress', 'In progress', j => pendingApplications.has(j.key) || j.active || ['applying', 'confirm_required'].includes(j.status.state)],
    ['ready', 'Ready to apply', j => j.status.state === 'ready' && !j.active && !pendingApplications.has(j.key)],
    ['attention', 'Needs attention', j => ['planned', 'found', 'failed', 'outcome_unknown'].includes(j.status.state) && !j.active],
    ['applied', 'Applied', j => ['applied', 'form_filled'].includes(j.status.state) && !j.active],
  ];

  function render() {
    const root = $('groups');
    root.replaceChildren();
    const matching = jobs.filter(j => (queueView === 'removed' ? !inQueue(j) : inQueue(j)) && [j.summary.title, j.summary.employer, j.summary.location, j.summary.jobId].filter(Boolean).join(' ').toLowerCase().includes(search));
    const tabs = $('queue-tabs');
    const visibleGroups = groups.filter(([id, , test]) => id !== 'progress' || jobs.some(j => inQueue(j) && test(j)));
    if (!visibleGroups.some(([id]) => id === queueTab)) queueTab = 'ready';
    tabs.replaceChildren(...visibleGroups.map(([id, title, test]) => el('button', {
      type: 'button', role: 'tab', class: 'tab' + (queueTab === id ? ' active' : ''),
      'aria-selected': String(queueTab === id), 'aria-controls': 'groups',
      onclick: () => { queueTab = id; selected.clear(); armed = false; render(); },
    }, title + ' (' + matching.filter(test).length + ')')));
    tabs.hidden = queueView === 'removed';
    const group = groups.find(([id]) => id === queueTab);
    const visible = queueView === 'removed' ? matching : matching.filter(group[2]);
    $('queue-count').textContent = visible.length + (visible.length === 1 ? ' job' : ' jobs');
    root.append(...visible.map(card));
    if (!visible.length) root.append(el('div', { class: 'empty' }, el('h2', {}, search ? 'No matching jobs' : queueView === 'removed' ? 'Nothing removed' : 'A new page awaits'), el('p', {}, search ? 'Try another role, company, or location.' : queueView === 'removed' ? 'Removed and expired jobs appear here. Your documents and history are kept.' : 'No jobs in ' + group[1].toLowerCase() + '. Ask your agent to prepare applications.')));
    updateBar();
  }

  function updateBar() {
    for (const key of [...selected]) if (!jobs.some(j => j.key === key && inQueue(j) && j.status.state === 'ready' && !j.active)) selected.delete(key);
    const ready = jobs.filter(j => inQueue(j) && j.status.state === 'ready' && !j.active && j.approvalHash);
    $('apply-bar').hidden = !canSubmit() || activeTab !== 'jobs' || queueView !== 'queue' || queueTab !== 'ready' || !ready.length;
    $('apply-count').textContent = selected.size + ' of ' + ready.length + ' selected';
    $('apply').disabled = preparing || dispatching || !selected.size || submissionBlocked || Boolean(knownCore());
    $('select-all').disabled = preparing || dispatching;
    $('application-mode').disabled = preparing || dispatching;
    if (preparing) { $('apply').textContent = 'Connecting submission session…'; return; }
    $('apply').title = knownCore() ? 'Insider is required for server applications.' : '';
    if (!armed) $('apply').textContent = $('application-mode').value === 'fill_only' ? 'Fill ' + selected.size + ' form' + (selected.size === 1 ? '' : 's') : selected.size ? 'Apply to ' + selected.size : 'Apply';
  }

${APPLICATION_APPROVAL_SCRIPT}

  function renderHealth(health) {
    const pill = (ok, text) => el('span', { class: 'pill ' + (ok ? 'ok' : 'bad') }, text);
    $('health').replaceChildren(
      pill(health.bridgeConnected, health.bridgeConnected ? 'Browser connected' : 'Browser not connected'),
      pill(health.authenticated, health.authenticated ? 'Signed in' : 'Signed out'),
    );
  }

${RECOVERY_UI_SCRIPT}

  async function load() {
    clearTimeout(timer);
    try {
      await refreshAccount();
      const state = await api('/api/state');
      const next = JSON.stringify([state.jobs, Boolean(state.workspaceOffline),state.submission,canSubmit()]);
      const approvalsBefore = approvalSelection();
      const fillOption = $('application-mode').querySelector('option[value="fill_only"]');
      if (canSubmit() && state.submission) {
        fillOption.hidden = !state.submission.fillOnly;
        fillOption.disabled = !state.submission.fillOnly;
        if (!state.submission.fillOnly) $('application-mode').value = 'submit';
      }
      const changed = next !== snapshot;
      snapshot = next;
      jobs = state.jobs;
      const approvalsAfter = approvalSelection();
      if (approvalsBefore !== approvalsAfter) armed = false;
      if (submissionReady && state.submission?.authenticated !== true) armed = false;
      submissionReady = state.submission?.authenticated === true;
      renderSubmissionBlocks(canSubmit() ? state.submissionBlocks : []);
      if (submissionBlocked) armed = false;
      if (state.profile) document.querySelector('.eyebrow').textContent = state.profile.name + ' / Application notebook';
      renderHealth(state.health);
      if (canSubmit() && state.submission) $('health').append(el('span', {class:'pill ' + (state.submission.connected ? 'ok' : 'bad')}, state.submission.authenticated ? 'Submission server ready' : state.submission.connected ? (state.submission.error || 'Submission server on standby') : 'Submission server disconnected'));
      const busy = jobs.some(j => j.active || j.status.state === 'applying');
      const signedIn = state.submission ? state.submission.connected : state.health.authenticated && state.health.bridgeConnected;
      $('status').textContent = statusNotice?.until > Date.now() ? statusNotice.message : state.workspaceOffline ? 'Workspace service is offline. Click Start workspace service to access saved applications and PDFs.'
        : !canSubmit() ? jobs.filter(inQueue).length + ' jobs in your queue. Use the manual application button to apply manually in WaterlooWorks.'
        : busy ? (jobs.find(j => j.status.state === 'applying')?.status.reason || 'Waiting to start the next application')
        : !signedIn ? 'Connect your submission server before applying.'
          : jobs.filter(inQueue).length + ' jobs in your queue. Review each application before submitting.';
      if (activeTab === 'materials' && materialsFailed && !state.workspaceOffline) void loadMaterials();
      // Preserve expanded details and selection unless the job data changed.
      if (state.workspaceOffline && !jobs.length) {
        $('groups').replaceChildren(el('p', { class: 'empty' }, 'Saved applications are unavailable while the workspace service is offline.'));
        updateBar();
      } else if (changed) { render(); }
      else updateBar();
      if(busy && typeof EventSource==='function')watchApplications();
      else {stopApplicationEvents();timer = setTimeout(load,15000);}
      return true;
    } catch (error) { $('status').textContent = error.message; timer = setTimeout(load, 15000); return false; }
  }

  async function loadMaterials() {
    const root = $('materials-panel');
    try {
      const data = await api('/api/materials');
      materialsFailed = false;
      const groups = [];
      const row = (title, path) => el('article', { class: 'card' }, el('p', { class: 'material-title' }, title), el('div', { class: 'actions' },
        el('button', { class: 'secondary', type: 'button', onclick: () => preview(path, title) }, 'Preview'),
        el('button', { class: 'secondary', type: 'button', onclick: async () => {
          try {
            const url = URL.createObjectURL(await api(path));
            const link = el('a', { href: url, download: title + '.pdf' });
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          } catch (error) { $('status').textContent = error.message; }
        } }, 'Download PDF')));
      groups.push(el('h2', {}, 'Resume variants (' + data.resumes.length + ')'));
      groups.push(...data.resumes.map(item => item.available ? row(item.label + ' · ' + item.id, '/api/materials/resumes/' + encodeURIComponent(item.id)) : el('article', { class: 'card' }, el('p', { class: 'material-title' }, item.label + ' · ' + item.id), el('p', { class: 'meta' }, 'PDF not generated yet.'))));
      groups.push(el('h2', {}, 'Generated job documents (' + data.documents.length + ')'));
      groups.push(...data.documents.map(item => row(item.title + ' · ' + item.key + ' · ' + item.state, materialPath(item.key, item.id))));
      if (!data.documents.length) groups.push(el('p', { class: 'empty' }, 'No generated job documents yet.'));
      root.replaceChildren(...groups);
    } catch (error) {
      materialsFailed = true;
      root.replaceChildren(el('p', { class: 'blockers' }, error.message), el('button', { type: 'button', class: 'secondary', onclick: loadMaterials }, 'Retry connection'));
    }
  }

  async function loadApplications() {
    const root = $('applications-panel');
    root.replaceChildren(el('p', { class: 'meta' }, 'Checking WaterlooWorks applications…'));
    try {
      const inventory = await api('/api/applications');
      root.replaceChildren(el('p', { class: 'meta' }, inventory.applications.length + ' application records for the selected recruiting term. Includes applications outside this workspace. Checked ' + new Date(inventory.checkedAt).toLocaleString()),
        el('button', { type: 'button', class: 'secondary', onclick: loadApplications }, 'Refresh applications'),
        ...inventory.applications.map(item => {
          const status = applicationStatus(item);
          return el('article', { class: 'card' },
          el('div', { class: 'application-heading' },
            el('p', { class: 'material-title' }, item.title + ' · ' + item.jobId),
            el('span', { class: 'state application-status', 'aria-label': 'Application status: ' + status.label }, status.label)),
          el('p', { class: 'meta' }, [item.employer, item.location, item.term].filter(Boolean).join(' · ')),
          status.jobStatus ? el('p', { class: 'meta application-source-status' }, 'Job status: ' + status.jobStatus + ' · Application status: ' + status.reported) : null,
          el('p', { class: 'meta' }, 'Submitted ' + new Date(item.submittedAt).toLocaleString() + ' · Application ' + item.applicationId));
        }));
    } catch (error) { root.replaceChildren(el('p', { class: 'blockers' }, error.message)); }
  }

  async function loadDiscoveries() {
    const root = $('discoveries-panel');
    await refreshAccount();
    if (knownCore()) { root.replaceChildren(el('h2', {}, 'Discoveries'), el('p', { class: 'meta' }, 'Daily job suggestions are included with Insider. Core includes browsing and manual applications. Insider also fills and submits applications after your approval.')); return; }
    root.replaceChildren(el('p', { class: 'meta' }, 'Loading discoveries…'));
    try {
      const data = await api('/api/discoveries');
      const items = data.discoveries || [];
      const content = [el('p', { class: 'meta' }, 'Matches from independent daily discovery. Ask your agent to review a posting before preparing an application.'), el('span', { class: 'premium-tag' }, 'INSIDER')];
      if (knownCore()) { root.replaceChildren(el('p', { class: 'meta' }, 'Discoveries are available with Insider.'), el('span', { class: 'premium-tag' }, 'INSIDER')); return; }
      if (!items.length) content.push(el('p', { class: 'empty' }, 'No discoveries yet. Configure matching rules in Settings or check the latest scan status below.'));
      for (const item of items) {
        const prompt = 'Please review WaterlooWorks posting ' + item.id + (item.title ? ' (' + item.title + ')' : '') + ' from the Discoveries inbox. Compare it with my saved targets and preferences, explain the fit and caveats, and prepare an application only if I ask. Do not submit or approve anything.';
        const copy = async () => {
          try { await navigator.clipboard.writeText(prompt); $('status').textContent = 'Copied an agent prompt for posting ' + item.id + '.'; }
          catch { $('status').textContent = 'Clipboard unavailable. Prompt: ' + prompt; }
        };
        content.push(el('article', { class: 'card' },
          el('p', { class: 'material-title' }, (item.title || 'Untitled posting') + ' · ' + item.id),
          el('p', { class: 'meta' }, [item.employer, item.location, 'Score ' + item.score, item.discoveredAt && new Date(item.discoveredAt).toLocaleString()].filter(Boolean).join(' · ')),
          el('h3', {}, 'Why it matched'),
          item.reasons?.length ? el('ul', { class: 'caveats' }, item.reasons.map(reason => el('li', {}, reason))) : el('p', { class: 'meta' }, 'No individual rule reasons were recorded.'),
          el('div', { class: 'actions' }, el('button', { type: 'button', class: 'secondary', onclick: copy }, 'Copy agent prompt'))));
      }
      root.replaceChildren(...content);
      try {
        const scan = await api('/api/discovery-status');
        root.append(el('p', { class: scan.error ? 'blockers' : 'meta' }, scan.error || (scan.lastSuccessAt ? 'Last successful scan: ' + new Date(scan.lastSuccessAt).toLocaleString() : 'Waiting for the first successful scan.')));
      } catch (error) { root.append(el('p', { class: 'meta' }, error.message)); }
    } catch (error) { root.replaceChildren(el('p', { class: 'blockers' }, error.message)); }
  }

  async function loadSettings() {
    const root = $('settings-panel');
    await refreshAccount();
    if (!canSubmit() && !globalThis.submissionDeveloperModeEnabled?.()) { root.replaceChildren(el('p', { class: 'meta' }, 'No settings available for your plan.')); return; }
    const submissionSettings = globalThis.createSubmissionSettingsPanel?.();
    const discoverySettings = el('section', {});
    root.replaceChildren(...(submissionSettings ? [submissionSettings] : []), discoverySettings);
    if (!canSubmit()) return;
    discoverySettings.replaceChildren(el('p', { class: 'meta' }, 'Loading discovery settings…'));
    try {
      const { policy } = await api('/api/discovery-policy');
      const form = el('form', { class: 'card' },
        el('h2', {}, 'Daily discovery'),
        el('p', { class: 'meta' }, 'The submission server checks WaterlooWorks daily, with a stable per-user offset within the selected hour. Matching rules are authored by your agent; these controls only change when discovery runs and its score threshold.'),
        el('div', { class: 'form-row' },
          el('label', {}, el('input', { type: 'checkbox', name: 'enabled', checked: policy.enabled }), ' Enable daily discovery'),
          el('label', {}, 'Run after hour (' + (policy.timeZone || 'America/Toronto') + ')', el('input', { type: 'number', name: 'hour', min: '0', max: '23', step: '1', value: String(policy.hour) })),
          el('label', {}, 'Minimum match score', el('input', { type: 'number', name: 'threshold', min: '0', step: '0.1', value: String(policy.threshold) }))),
        el('h3', {}, 'Agent-authored matching rules'),
        policy.rules?.length ? el('div', {}, policy.rules.map(rule => el('div', { class: 'rule' }, rule.phrase + ' · ' + rule.field + ' · weight ' + (rule.weight >= 0 ? '+' : '') + rule.weight))) : el('p', { class: 'empty' }, 'No matching rules saved. Ask your agent to create rules from your preferences.'),
        el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Save discovery settings')));
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const enabled = form.querySelector('[name=enabled]').checked;
        const hour = Number(form.querySelector('[name=hour]').value);
        const threshold = Number(form.querySelector('[name=threshold]').value);
        const button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          await api('/api/discovery-policy', { policy: { ...policy, enabled, hour, threshold } });
          $('status').textContent = 'Discovery settings saved.';
        } catch (error) { $('status').textContent = error.message; }
        finally { button.disabled = false; }
      });
      discoverySettings.replaceChildren(form);
    } catch (error) { discoverySettings.replaceChildren(el('p', { class: 'blockers' }, error.message)); }
  }

  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === tab));
    for (const name of ['jobs', 'applications', 'materials', 'discoveries', 'settings']) $(name + '-panel').hidden = name !== activeTab;
    updateBar();
    if (activeTab === 'materials') void loadMaterials();
    else if (activeTab === 'applications') void loadApplications();
    else if (activeTab === 'discoveries') void loadDiscoveries();
    else if (activeTab === 'settings') void loadSettings();
    else render();
  });

  document.addEventListener('workspace-connected', () => {
    void load();
    void refreshAccount();
    if (activeTab === 'materials') void loadMaterials();
  });
  document.addEventListener('insider-account-changed', () => { void load().then(() => { render(); if (activeTab === 'discoveries') void loadDiscoveries(); if (activeTab === 'settings') void loadSettings(); }); });
  document.addEventListener('submission-developer-mode-changed', () => { if (activeTab === 'settings') void loadSettings(); });

  $('job-search').addEventListener('input', event => { search = event.target.value.trim().toLowerCase(); render(); });
  $('queue-filter').addEventListener('change', event => { queueView = event.target.value; selected.clear(); armed = false; render(); });
  $('application-mode').addEventListener('change', () => { armed = false; updateBar(); });
  $('apply').addEventListener('click', applySelected);
  void refreshAccount();
  $('select-all').addEventListener('click', () => { armed = false; for (const j of jobs) if (inQueue(j) && j.status.state === 'ready' && !j.active && j.approvalHash) selected.add(j.key); render(); });
  void load();
})();
`;
