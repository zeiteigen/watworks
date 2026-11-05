---
name: job-search
description: Search WaterlooWorks using saved targets and preferences, shortlist matches, and prepare multiple applications with validated plans for user review in the dashboard. Use for an end-to-end job search with application preparation after onboarding. Use apply-job for one specified posting ID or name.
metadata:
  short-description: Find matching jobs and prepare applications for the dashboard
---

# Find jobs and prepare applications

End with saved jobs that are `ready`, explicitly Needs attention, or `skipped`
with reasons, then return the dashboard URL. The user controls form filling and
submission. Requests to apply to one identified posting belong to
[apply-job](../apply-job/SKILL.md). Users inspect full saved postings, required
documents, screening questions, and prepared materials with **View in detail**
in the dashboard queue.

## Load context

1. Call `workspace_status`, `profile_get`, and `resume_list`. If the profile,
   experience draft, or usable resume PDFs are missing, direct the user to
   `/onboard` (Codex: `$onboard`) and explain what is missing. Stop preparation
   until that context is available.
2. Call `waterlooworks_status`; continue remote reads only when `authenticated`,
   `bridgeConnected`, and `bootstrapped` are true. Otherwise guide the user to
   sign in through the extension and recheck. Never request session material.
3. Follow requested targets and count, using saved preferences and authorization.
   If unspecified, use saved targets and prepare up to 15 strong matches. Ask
   only when missing criteria materially affect the work; do not ask again for
   facts already in the profile.
4. Call `jobs_list` to identify existing plans and protected application states.
   Do not re-plan `applied`, `form_filled`, `applying`, `confirm_required`, or
   `outcome_unknown` jobs or automatically replay failed attempts.

## Search and shortlist

Call `jobs_search` with focused keywords from selected targets; this also records
searches in the workspace. Use `waterlooworks_get_search_metadata` before building
filters; never invent keys or values. Merge/de-duplicate results by ID. Exclude
postings already showing an application and protected saved states.

Shortlist by role, employer, location, term, pay, and deadline against the user's
constraints. Favor strong matches over filling a quota. Search summaries are
preliminary: save and read detailed postings before final fit or document claims.
Use employer-history reads when useful; do not rerun the entire research skill.

## Prepare the shortlist

Read [the shared preparation guide](../apply-job/references/prepare-application.md)
and follow it for each ID. This is the single preparation procedure for resume
selection, generated documents, screening answers, eligibility, and validated
plans. Batch questions for missing facts across jobs. Use `job_skip` with reasons
for confirmed hard mismatches; keep missing answers or ambiguous documents under
Needs attention.

## Hand off

Call `jobs_list` and report results from this run in a ranked Markdown table:
posting/ID, employer/location, deadline, resume variant, required documents,
status, and fit. Include compensation when listed. List skipped jobs and reasons,
and every job needing attention with its missing material or clarification.
Never imply unresolved plans are ready or other saved jobs were prepared in this run.
Point the user to **View in detail** on a job card to inspect its full posting
and requirements alongside their prepared materials.

Call `dashboard_open` and return its URL. The user reviews materials and chooses
**Fill and submit**, or **Fill form only** when an accessible self-hosted GUI
is advertised. Fill-only leaves a server-side page open; Cloudflare does not
offer it. The user configures the endpoint in extension settings. Session transfer occurs
automatically on application preparation or discovery demand; passive polling stays
passive. Endpoint or proxy-setting changes invalidate the prior session binding. Processed attachments are checked under the
original approval. Never open the dashboard, call its HTTP routes, or operate approval
controls. Do not call direct submission, upload, or default-change tools in this
workspace preparation flow. Save personal workspace data through MCP tools.

Daily discovery is independent: use `discovery_policy_get`,
`discovery_policy_save`, and `discoveries_list` only for that requested workflow,
grounded in user preferences. Discovery does not prepare or submit applications.
