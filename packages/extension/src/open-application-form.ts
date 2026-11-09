import { WATERLOOWORKS_JOBS_URL } from "../../shared/src/protocol.js";
import { isPostingId, WaterlooWorksSite } from "../../waterlooworks-client/src/site-interface.js";
import type { BrowserApplicationReads } from "./application-reads.js";
import { chromeWaterlooWorksBrowser } from "./waterlooworks-browser.js";

const site = new WaterlooWorksSite(chromeWaterlooWorksBrowser);

/** Opens the validated application entry, leaving every form control to the user. */
export async function openApplicationForm(jobId: unknown, reads: Pick<BrowserApplicationReads, "getApplicationEntry">) {
  if (!isPostingId(jobId)) throw new Error("Invalid WaterlooWorks posting ID");
  const entry = await reads.getApplicationEntry(jobId);
  const tabId = await chromeWaterlooWorksBrowser.open(WATERLOOWORKS_JOBS_URL);
  await site.enterApplication(tabId, jobId, entry.fields);
  return { tabId, jobId };
}

/** Shows the posting's own panel on the WaterlooWorks jobs page. */
export async function openPosting(jobId: unknown) {
  if (!isPostingId(jobId)) throw new Error("Invalid WaterlooWorks posting ID");
  const tabId = await chromeWaterlooWorksBrowser.open(WATERLOOWORKS_JOBS_URL);
  await site.showPosting(tabId, jobId);
  return { tabId, jobId };
}
