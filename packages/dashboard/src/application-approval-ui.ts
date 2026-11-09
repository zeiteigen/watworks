/** Explicit approval, on-demand session preparation, and one dispatch per selected job. */
export const APPLICATION_APPROVAL_SCRIPT = String.raw`
  function approvalSelection() {
    return JSON.stringify([$('application-mode').value, jobs.filter(j => selected.has(j.key)).map(j => [j.key, j.approvalHash, j.status.state, j.active]).sort((a,b) => a[0].localeCompare(b[0]))]);
  }
  async function applySelected() {
    if (preparing || dispatching || !selected.size) return;
    if (!canApprove()) { notice(EXTENSION_ONLY); return; }
    if (knownCore()) { $('status').textContent = 'Insider is required for server applications. Manual applications remain available.'; return; }
    if (submissionBlocked) { $('status').textContent = 'Resolve the submission block above before applying.'; return; }
    if (!armed) {
      if (!submissionReady) {
        preparing = true;
        const selection = JSON.stringify([...selected]);
        updateBar();
        $('status').textContent = 'Connecting submission session…';
        try {
          await api('/api/submission/prepare', {});
          if (!await load() || selection !== JSON.stringify([...selected]) || !canSubmit() || submissionBlocked) return;
        } catch(error) { notice(error.message); return; }
        finally { preparing = false; updateBar(); }
      }
      armed = true;
      $('apply').textContent = ($('application-mode').value === 'fill_only' ? 'Click again to fill without submitting ' : 'Click again to submit ') + selected.size + ' application' + (selected.size === 1 ? '' : 's');
      return;
    }
    armed = false;
    dispatching = true;
    const executionMode = $('application-mode').value || undefined;
    const chosen = jobs.filter(j => inQueue(j) && j.status.state === 'ready' && !j.active && selected.has(j.key) && pins.get(j.key) === j.reviewHash);
    selected.clear();
    for (const job of chosen) unpin(job.key);
    for (const job of chosen) pendingApplications.set(job.key, 'Waiting to start…');
    queueTab = 'progress';
    queueView = 'queue';
    search = '';
    $('job-search').value = '';
    render();
    try {
      for (const job of chosen) {
        pendingApplications.set(job.key, 'Starting application…');
        render();
        try { await api(jobPath(job.key) + '/apply', { approvalHash: job.approvalHash, executionMode, approval: await writeApproval('apply', job.key) }); }
        catch (error) { notice(job.summary.title + ': ' + error.message); }
      }
      await load();
    } finally {
      for (const job of chosen) pendingApplications.delete(job.key);
      dispatching = false;
      render();
    }
  }

`;
