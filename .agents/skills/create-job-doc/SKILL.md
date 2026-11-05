---
name: create-job-doc
description: Create a cover letter or other job-specific document (project summary, writing sample, portfolio notes, statement of interest, or anything a posting asks for) for one job, given its posting ID. Fetches and saves the posting if needed, writes the document from the user's experience draft, compiles it to PDF with the LaTeX templates, and can attach it to the job's application plan. Use when the user asks for a cover letter or a document for a specific job ID.
metadata:
  short-description: Write a cover letter or other document for one job ID
---

# Create a job document

The extension owns local WaterlooWorks research, parsing, and sign-in state.
The configured submission server owns application reads and Playwright UI writes.
The extension dashboard displays generated materials and is the user's approval
boundary; its workspace API is at `http://127.0.0.1:39452/`. You may return the
dashboard URL, but never open it, call its HTTP routes, or use its controls. The
WaterlooWorks cookies and the browser user agent transfer automatically to the
configured endpoint when application preparation or discovery needs a session.
They never pass through the workspace
service, broker, dashboard, or agent. The extension is built and loaded unpacked
from the local checkout; it is not published.

Input: a posting ID (for example `412001`, or `waterlooworks:412001`) and,
optionally, which document to write. If the user gave no ID, ask for it.

## 1. Load context

1. Call `profile_get`. If there is no profile or experience draft, tell the
   user to run `/onboard` (Codex: `$onboard`) first and stop.
2. Call `job_documents` with `jobKey` `waterlooworks:<id>`. If the job is
   unknown, call `job_save` with the ID first. This needs a connected
   WaterlooWorks session; if `waterlooworks_status` is not ready, guide the
   user to sign in.
3. Read the posting's `description.md`. Note the application form's document
   `slots` (attachment requirements and their labels) and any existing
   documents and plan.

## 2. Decide what to write

- If the user named a document, write that.
- Otherwise, list the attachment slots the posting requires that are not yet
  covered by an existing document, and ask which to create. Default to a cover
  letter when the posting requires one.
- Documents that must come from an official source, such as transcripts,
  grade reports, or work permits, cannot be generated. Tell the user to put
  the PDF in `data/` and reference it with `{kind: "file", ...}` in the plan.

## 3. Write it

Use only facts from the experience draft and the profile. Never invent
experience, metrics, skills, or personal details. Only mention work
authorization if the posting asks for it. For a Canadian citizen applying in
Canada, state that they are a Canadian citizen eligible to work in Canada with
no sponsorship required. Never claim US work authorization the profile does
not record (see [work authorization](../apply-job/references/work-authorization.md)). Tie the content to the
posting's responsibilities and qualifications. Keep it specific and concise.

- **Cover letter:** call `cover_letter_save` with `jobKey` and a letter
  (recipient company, and name or title if the posting lists one; 3–4
  paragraphs; one page).
- **Any other document:** call `job_document_save` with `jobKey`, a
  `document` id (lowercase with hyphens, for example `project-summary`), and
  `content`: a title, an optional subtitle, and sections of paragraphs
  and/or bullets. Follow any length or format the posting specifies.

If compilation reports more pages than the posting allows, tighten the
content and save again. A newly created PDF opens automatically on the user's
machine (`opened: true`); re-saves do not reopen it. Tell the user it is open
(or give the path if `opened` is false) and ask them to review it. Apply their
edits by saving again with the same id.

## 4. Attach it (optional)

If the job has an application plan, or the user wants it ready for the
dashboard, update the plan with `application_plan_save`. Keep the existing
plan fields and add the attachment for the matching slot:

- cover letter: `{kind: "cover_letter", requirementId}`
- other document: `{kind: "document", requirementId, document: "<id>"}`

If there is no plan yet, offer to run the rest of the preparation (resume
variant and screening answers) with [apply-job](../apply-job/SKILL.md). Never apply or submit; the
user does that from the dashboard (`dashboard_open`).
