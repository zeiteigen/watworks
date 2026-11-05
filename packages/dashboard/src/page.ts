export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Job applications</title><link rel="stylesheet" href="/dashboard.css"><script src="/dashboard.js" defer></script></head>
<body><main>
<div class="masthead"><span class="wordmark"><svg viewBox="0 0 64 64" width="32" height="40" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M32.2 4.5 31.8 55 M32 6 20 21 44 20 M32 17 13 37 51 36 M32 30 6 53 58 52"/></g></svg>wat<span class="ink">/</span>mcp</span><span class="workspace-note">Your next chapter, in progress.</span></div>
<header><div><p class="eyebrow">Your application notebook</p>
<p class="lede">Review your documents and answers, then apply. Each application needs your approval.</p></div>
<div class="header-status"><div id="account-plan" class="account-plan" aria-live="polite"><span class="plan-label">Core</span><span class="meta">Recognizing your WaterlooWorks account…</span></div><div id="health" class="health" aria-live="polite"></div></div></header>
<section id="insider-nudge" class="insider-nudge" aria-labelledby="insider-nudge-title" hidden>
<div><span class="premium-tag">INSIDER</span><h2 id="insider-nudge-title">Let Insider do the applying.</h2>
<p>Fill and submit applications automatically after your approval, and get daily job suggestions.</p>
<p class="meta">Also: Core opens manual applications after a 5-second wait. Insider opens them instantly.</p></div>
<a class="button-link" href="https://watworks.alishahzad.dev/#insider" target="_blank" rel="noopener noreferrer">Contact for Insider access ↗</a>
</section>
<nav class="tabs" aria-label="Workspace sections"><button type="button" class="tab active" data-tab="jobs">Jobs</button><button type="button" class="tab" data-tab="applications">All applications</button><button type="button" class="tab" data-tab="materials">Materials</button><button type="button" class="tab" data-tab="discoveries">Discoveries <span class="premium-tag">INSIDER</span></button><button type="button" class="tab" data-tab="settings">Settings</button></nav>
<p id="status" role="status" aria-live="polite">Loading…</p>
<section hidden id="submission-blocks" aria-label="Submission block status" aria-live="polite"></section>
<section id="jobs-panel">
<div class="queue-tools"><label class="search-label" for="job-search">Find a job<input id="job-search" type="search" placeholder="Search role, company, or location…" autocomplete="off"></label><label for="queue-filter">Show<select id="queue-filter"><option value="queue">In the queue</option><option value="removed">Removed jobs</option></select></label><span id="queue-count" class="meta" aria-live="polite"></span></div>
<nav id="queue-tabs" class="tabs queue-tabs" role="tablist" aria-label="Job status"></nav>
<section id="groups" aria-label="Saved jobs"></section></section>
<section id="materials-panel" hidden></section>
<section id="applications-panel" hidden></section>
<section id="discoveries-panel" hidden></section>
<section id="settings-panel" hidden></section>
</main>
<div id="apply-bar" class="apply-bar" hidden><span id="apply-count"></span><button id="select-all" type="button" class="secondary">Select all ready</button><label for="application-mode">Action<select id="application-mode"><option value="submit">Fill and submit</option><option value="fill_only">Fill form only</option></select></label><span class="premium-tag">INSIDER</span><button id="apply" type="button">Apply</button></div>
</body></html>`;

export { DASHBOARD_STYLE } from "./style.js";
export { DASHBOARD_SCRIPT } from "./script.js";
