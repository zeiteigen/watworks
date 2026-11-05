# Prepare a saved application

Shared by `apply-job` for one posting and `job-search` for a shortlist. Reuse
loaded profile, experience, resume inventory, and connection status; load any
that are missing. All personal workspace writes use MCP tools.

## Save and screen

Call `job_save` with `source: "waterlooworks"` and the selected `jobId`. Read its
`description` file and the form's `requirements`, `questions`, `blockers`,
`externalSteps`, and any `formError`. Call `job_documents` for the existing plan,
generated PDFs, slots, and full saved status. Do not infer requirements from
search summaries or the user's available documents. If the fresh summary reports
`hasApplication`, stop and report it is already applied. When application presence
is unclear, read `waterlooworks_get_application_status` before preparing another
plan; do not duplicate an application made outside this workspace.

Do not re-plan `applied`, `form_filled`, `applying`, `confirm_required`, or
`outcome_unknown` jobs. Do not bypass a failed attempt's retry protection by
rewriting its plan; recovery belongs to the user's dashboard controls. If status
has `removedFromQueueAt`, preparation does not restore it: tell the user it
remains under Removed jobs and must be restored in the dashboard.

Check eligibility, deadline, work location/arrangement, term, pay, and explicit
constraints. Distinguish unknowns from proven disqualifiers. For Canadian
citizens, read [work-authorization.md](work-authorization.md) when screening or
answering authorization questions. Never infer personal facts, clearances, or
willingness to relocate or obtain clearance from silence.

Batch searches skip confirmed hard mismatches with `job_skip` and a reason.
Specific-job requests report blockers or clarify preference conflicts instead
of silently choosing a different job. External-only forms and form errors cannot
become ready through this workflow. Report additional employer-site steps as
outstanding even when the internal plan is ready.

## Materials and answers

- **Resume:** use `resume_list` to select the best existing variant. If none
  fits, create a one-page variant with `resume_save_variant`, using only facts
  from the experience draft. Reuse a suitable PDF already present.
- **Cover letter:** use `cover_letter_save` when the form/posting requires one,
  or the user requests it. Connect real experience to the role in a concise
  one-page letter.
- **Other attachments:** reconcile posting instructions with every required
  slot, including “Other - Per Job Posting”. Use `job_document_save` for
  authorable summaries, writing samples, and other requested content. Official
  transcripts, certificates, and permits must come from the user; ask for the
  existing PDF. Attach with exact slot IDs. If generic slots are undefined or
  instructions disagree, ask for clarification and leave them unresolved.
  Never generate filler or official documents.
- **Screening:** use exact `questionId`s and option IDs from the form. Answer
  from the profile, standard answers, and experience draft. Ask for missing
  required facts; batch questions across jobs. Offer to save reusable answers
  with `profile_save`, preserving the other fields.
- **PDF verification:** check page counts and compilation warnings. Trim/re-save
  resumes to one page and documents to the posting's limits. A newly created
  PDF opens automatically (`opened: true`); re-saves do not. Tell the user which
  materials are available for review.

## Validate the plan

Call `application_plan_save` with `jobKey` and the complete `plan`:

- `resumeVariant`: selected variant ID.
- `attachments`: `{kind: "cover_letter", requirementId}`,
  `{kind: "document", requirementId, document}`, or
  `{kind: "file", requirementId, path}` for an existing PDF inside `data/`.
- `answers`: `{questionId, value}` entries with actual question/option IDs.
- `fit`: one or two sentences; `caveats`: relevant gaps and unknowns.
- `rank`: optional positive integer for batch prioritization; retain an existing
  rank on a single-job update unless the user requests a change.

Preserve existing plan fields and attachments that still meet requirements.
`ready` means validation succeeded. If the result is `planned` with blockers,
fix what the saved facts/materials support and save again. Ask for missing input
and report Needs attention when unresolved. Never invent an answer or describe
an incomplete application as ready. Preparation does not fill or submit a
WaterlooWorks form. Return to the calling skill for the dashboard handoff.
