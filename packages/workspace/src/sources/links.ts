/** Manual-application availability; the extension opens the posting through the site's application form. */
const MANUAL_APPLY: Record<string, (jobId: string) => { url: string; hint: string }> = {
  waterlooworks: jobId => ({
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm",
    hint: `Open application form for posting ${jobId} in WaterlooWorks`,
  }),
};

export function manualApplyLink(source: string, jobId: string): { url: string; hint: string } | undefined {
  return MANUAL_APPLY[source]?.(jobId);
}
