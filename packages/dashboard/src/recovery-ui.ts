/** Guided recovery controls; all decisions remain validated by the workspace service. */
export const RECOVERY_UI_SCRIPT = String.raw`
  function showRecovery(job) {
    const view = openDialog('Resolve application · ' + job.summary.title);
    const feedback = el('p', { role: 'status', class: 'meta' });
    const acknowledged = el('input', { type: 'checkbox' });
    const check = el('button', { type: 'button', disabled: true }, 'Check status and prepare again');
    acknowledged.addEventListener('change', () => { check.disabled = !acknowledged.checked; });
    check.addEventListener('click', async () => {
      check.disabled = true;
      feedback.textContent = 'Checking WaterlooWorks. Nothing will be submitted…';
      try {
        const result = await api(jobPath(job.key) + '/recover', { acknowledged: true, updatedAt: job.status.updatedAt, approval: await writeApproval('recover', job.key) });
        await load();
        const status = result.status;
        feedback.textContent = status.state === 'applied' ? 'Application verified. This job is now in Applied.' + (submissionBlocked ? ' Another operation still pauses submissions. Use Unblock other jobs if you need to continue while it is unresolved.' : '')
          : status.state === 'ready' ? 'No submitted application found. This job is back in Ready to apply. Review its documents and approve Apply when ready.'
          : 'No submitted application found. This job still needs preparation: ' + status.blockers.join(' · ');
        acknowledged.disabled = true;
        view.body.append(el('div', { class: 'actions' }, el('button', { type: 'button', onclick: () => {
          view.close();
          queueView = 'queue';
          queueTab = status.state === 'ready' ? 'ready' : status.state === 'applied' ? 'applied' : 'attention';
          search = '';
          $('job-search').value = '';
          $('queue-filter').value = 'queue';
          open.add(job.key);
          document.querySelector('[data-tab="jobs"]').click();
        } }, status.state === 'ready' ? 'View in Ready to apply' : status.state === 'applied' ? 'View in Applied' : 'View remaining requirements')));

      } catch (error) {
        feedback.textContent = error.message;
        feedback.className = 'blockers';
        check.disabled = !acknowledged.checked;
      }
    });
    view.body.append(
      el('p', {}, job.status.reason || 'This application needs your attention.'),
      job.status.blockers.length ? el('ul', { class: 'blockers' }, job.status.blockers.map(text => el('li', {}, text))) : '',
      el('ol', { class: 'recovery-steps' },
        el('li', {}, 'Check the application in WaterlooWorks.', el('div', { class: 'actions' }, el('button', { type: 'button', class: 'secondary', onclick: () => openApplicationForm(job) }, 'Open in WaterlooWorks ↗'))),
        el('li', {}, 'Run a status check. A submitted application moves to Applied. If none exists, we check the requirements and prepare the job for your review.')),
      el('p', { class: 'meta' }, 'If documents or answers are missing, ask your agent to update this application. Earlier uploads may already exist. This check never submits an application.'),
      el('label', { class: 'recovery-ack' }, acknowledged, ' Allow a new attempt only if WaterlooWorks confirms no application was submitted.'),
      el('div', { class: 'actions' }, check), feedback);
  }

  let refreshBlockDialog;
  function showBlockRelease(block) {
    const view = openDialog('Unblock other applications');
    const reason = el('textarea', { name: 'reason', maxlength: '500', required: true, rows: '2', placeholder: 'What did you check in WaterlooWorks?' });
    const acknowledge = el('input', { type: 'checkbox', name: 'acknowledged', required: true });
    const release = el('button', { type: 'submit', disabled: true }, 'Unblock other jobs');
    const feedback = el('p', { role: 'status', class: 'meta' });
    const availability = el('p', { class: 'meta', role: 'status' }, block.releaseDisabledReason || '');
    const form = el('form', { class: 'recovery-form' },
      el('p', {}, 'Use this if you need to continue with other jobs while this operation remains unresolved. It does not submit anything or allow this application to be retried.'),
      availability,
      el('label', {}, 'What you checked', reason),
      el('label', {}, acknowledge, ' I checked WaterlooWorks and want to unblock other jobs. This operation’s outcome remains uncertain.'),
      release, feedback);
    const ready = () => { release.disabled = !block.canRelease || !acknowledge.checked || !reason.value.trim(); };
    const refresh = blocks => {
      if (!blocks) { release.disabled = true; availability.textContent = 'Reconnect the workspace service to continue.'; return; }
      const current = blocks.find(item => item.id === block.id);
      if (!current) { view.close(); return; }
      block = current;
      availability.textContent = block.releaseDisabledReason || '';
      ready();
    };
    refreshBlockDialog = refresh;
    view.cleanups.push(() => { if (refreshBlockDialog === refresh) refreshBlockDialog = undefined; });
    form.addEventListener('input', ready);
    form.addEventListener('change', ready);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (release.disabled) return;
      release.disabled = true;
      try {
        await api('/api/submission-blocks/' + encodeURIComponent(block.id) + '/release', { updatedAt: block.updatedAt, acknowledged: true, reason: reason.value.trim(), approval: await writeApproval('release', block.id) });
        await load();
        view.close();
        notice('Other jobs are unblocked. Nothing was submitted or retried.');
      } catch (error) { feedback.textContent = error.message; ready(); }
    });
    view.body.append(form);
  }

  function renderSubmissionBlocks(blocks) {
    refreshBlockDialog?.(blocks);
    const next = JSON.stringify([blocks ?? null, jobs.map(job => [job.key, job.status.state, job.active])]);
    submissionBlocked = Boolean(blocks?.length);
    if (next === blockSnapshot) return;
    blockSnapshot = next;
    const root = $('submission-blocks');
    root.replaceChildren();
    root.hidden = !blocks?.length;
    if (!blocks?.length) return;
    root.append(el('h2', {}, 'An application needs your attention'),
      el('p', {}, 'New applications are paused. Check the affected operation in WaterlooWorks, then choose a recovery action below.'));
    for (const block of blocks) {
      const job = jobs.find(job => job.key === block.jobKey && inQueue(job));
      const actions = el('div', { class: 'actions' });
      if (job && ['failed', 'outcome_unknown', 'planned', 'found'].includes(job.status.state) && !job.active) actions.append(el('button', { type: 'button', onclick: () => showRecovery(job) }, 'Resolve application'));
      if (job?.manualApply) actions.append(el('button', { type: 'button', class: 'secondary', onclick: () => openApplicationForm(job) }, 'Open in WaterlooWorks ↗'));
      actions.append(el('button', { type: 'button', class: 'secondary', onclick: () => showBlockRelease(block) }, 'Unblock other jobs…'));
      root.append(el('article', { class: 'recovery-item' },
        el('p', { class: 'material-title' }, block.title ? block.title + ' · ' + block.employer : block.kind === 'upload_document' ? 'Document upload needs checking' : 'Operation needs checking'),
        el('p', { class: 'meta' }, 'Since ' + new Date(block.createdAt).toLocaleString() + ' · ' + (block.state === 'outcome_unknown' ? 'Submission not verified' : 'Operation may still be running')),
        block.releaseDisabledReason ? el('p', { class: 'meta' }, block.releaseDisabledReason) : '',
        actions));
    }
  }
`;
