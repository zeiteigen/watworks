/** Display-only interpretation; original submission evidence remains unchanged. */
export const APPLICATION_STATUS_SCRIPT = String.raw`
  function applicationStatus(item) {
    const reported = typeof item.status === 'string' && item.status.trim() ? item.status.trim() : 'Unavailable';
    const jobStatus = typeof item.jobStatus === 'string' ? item.jobStatus.trim() : '';
    const normalized = jobStatus.toLowerCase().replace(/\s+/g, ' ');
    const pending = ['open for applications', 'expired - apps available', 'expired - apps availible'];
    const inferred = ['applied', 'submitted'].includes(reported.toLowerCase()) && Boolean(jobStatus) && !pending.includes(normalized);
    return { label: inferred ? 'Not selected (inferred)' : reported, reported, jobStatus };
  }
`;
