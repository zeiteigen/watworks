---
name: apply-job
description: Prepare an application for one WaterlooWorks job identified by posting ID, job key, or title/employer name, including resume selection, required documents, screening answers, and a validated dashboard plan. Use when the user asks to apply to a specific job. The user fills or submits from the dashboard; use job-search for batch discovery and preparation, or create-job-doc for a document-only request.
metadata:
  short-description: Prepare one job application by ID or name
---

# Apply to a specific job

Accept “apply to 412001”, “apply to waterlooworks:412001”, or “apply to Software
Developer at Acme”. Prepare that application and return the dashboard URL for
the user's final action. Do not search for unrelated jobs.

## Load context and identify the posting

1. Call `workspace_status`, `profile_get`, and `resume_list`. If the profile,
   experience draft, or usable resume PDFs are missing, explain what is missing
   and direct the user to `/onboard` (Codex: `$onboard`). Stop preparation
   until that context is available; do not invent a profile.
2. Call `waterlooworks_status`. Fetch fresh posting/form data only when
   `authenticated`, `bridgeConnected`, and `bootstrapped` are true. If needed,
   guide the user to sign in through the extension and recheck; never request
   credentials or session material.
3. Call `jobs_list` to check saved matches and application states.
   - **Numeric ID or `waterlooworks:<id>`:** use that exact ID. Do not keyword
     search or substitute another posting if it is unavailable.
   - **Name:** match title and supplied employer/term against saved summaries.
     If no unique, convincing match exists, call `waterlooworks_search_jobs`
     with a focused keyword from the name. Read full details with
     `waterlooworks_get_job` when needed to distinguish candidates. Consult
     `waterlooworks_get_search_metadata` before adding filters.
   - **Ambiguous name:** show plausible IDs, titles, employers, and terms and
     ask the user to choose. Do not pick the first or highest-ranked result.
   - **No match:** report the failed lookup and ask for an ID or more specific
     name. Do not generate materials for a guessed posting.
4. Check the matching saved state before preparing anything. For `applied`,
   report it is already applied. For `form_filled`, direct the user to review
   the existing WaterlooWorks tab and submit there. For `applying`,
   `confirm_required`, or `outcome_unknown`, report the state and return the
   dashboard URL via `dashboard_open` for review; do not start another attempt.
   These state branches end this workflow: do not continue to preparation or the
   general handoff. For `form_filled`, the existing WaterlooWorks tab is where
   the user finishes; do not offer a fresh dashboard apply action.

## Prepare the selected job

Read [the shared application preparation guide](references/prepare-application.md)
and follow it for the resolved ID. It is also used by `job-search`. Preserve
useful existing materials and plan fields instead of regenerating without reason.

If the posting conflicts with a saved preference, explain the conflict and
honor an explicit override in the current request. Ask if a hard preference
conflict remains unresolved. Never override actual eligibility requirements or
invent screening answers. Report unavailable, expired, or external-only postings
with blockers instead of claiming an application is ready.

## Hand off

Report the exact title, employer, ID, selected resume, required documents,
remaining external steps, and preparation status. List missing materials or
answers explicitly. Only call the job ready when `application_plan_save` validates
it without blockers; unresolved jobs remain under Needs attention.

Call `dashboard_open` and give its URL to the user. They review materials and
choose **Fill and submit**, or **Fill form only** when the configured server
advertises an accessible self-hosted GUI. Fill-only leaves the server-side
WaterlooWorks page at Submit; Cloudflare does not offer this mode. Processed
attachments are checked under the original approval. If the user requested
fill-only, explain the accessible-desktop requirement and available capability; the plan tool does not set an execution mode. Never
claim the form was filled or submitted by this skill.

Never open the dashboard, call its HTTP routes, or operate approval controls.
Do not call `waterlooworks_submit_application`, upload documents, change defaults,
or automate an external application site in this preparation workflow. Write
personal workspace data through MCP tools, never by editing `data/` files.
