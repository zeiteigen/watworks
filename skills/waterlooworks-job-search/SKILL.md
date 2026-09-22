---
name: waterlooworks-job-search
description: Use the local read-only WaterlooWorks MCP to find, compare, and evaluate University of Waterloo co-op postings, using the user's resume and career goals when available and presenting shortlists as concise Markdown tables.
metadata:
  short-description: Research and compare WaterlooWorks co-op jobs
---

# WaterlooWorks job research

Use this skill when the user wants help discovering, comparing, or evaluating
University of Waterloo co-op postings through the local WaterlooWorks MCP. The
MCP is read-only: it can inspect postings, account/document metadata, and
employer reports, but it cannot submit applications or change the user's
account.

## Build enough user context

Before making a tailored recommendation, ask for whatever context is missing.
Invite the user to share a resume (full text, a redacted copy, or a concise
skills/projects summary), plus:

- career aspirations, target roles, industries, and skills they want to grow;
- academic program, year, relevant courses/projects, and work-term number;
- preferred location, remote/hybrid/on-site arrangement, term/duration, and
  compensation priorities;
- constraints such as work authorization, commute, accessibility, or deadline;
- whether they want broad discovery, a fit assessment, employer-history
  comparison, or help understanding a particular posting.

Do not request passwords, cookies, session IDs, action tokens, or other
credentials. A resume is optional: if the user wants an immediate search,
search using the criteria already supplied and say that a resume or profile
would improve fit judgments. Treat resume and aspiration information as user
context, not as facts retrieved from WaterlooWorks.

## Use the MCP in this order

1. Call `waterlooworks_status` at the start of a research task, when the
   authentication state is unknown, or after a failed request. Continue only
   when `authenticated`, `bridgeConnected`, and `bootstrapped` are all true.
   If authentication is false, tell the user to sign in to WaterlooWorks in
   the Chromium profile connected to the extension, then recheck status. Never
   ask them to paste credential material.
2. Translate the user's goals into a focused keyword and explicit criteria.
   Call `waterlooworks_get_search_metadata` before constructing advanced
   filters when filter names or values are not known. Do not invent filter
   keys or employer IDs.
3. Call `waterlooworks_search_jobs`. Search is intentionally unpaged and
   returns every match, so use `total` and summary fields to shortlist a
   manageable set of posting IDs. Do not retrieve full details for every
   result unless the user asks for that.
4. Call `waterlooworks_get_job` for each shortlisted numeric ID. It returns
   normalized description, duties, qualifications, location, work term,
   compensation, application details, service-team contacts, and parsed
   pre-screening questions/options. Pre-screening is included by default;
   set `includePreScreening: false` only when it is irrelevant to the task.
5. When employer history is useful, call
   `waterlooworks_get_employer_report` after `get_job`, passing the posting's
   numeric `divisionId` as `companyId` when present. Never derive an ID from an
   employer name. Treat `reportAvailable: false` as a normal no-history result,
   not as a failed request, and distinguish missing data from a measured zero.
6. Use `waterlooworks_get_account_overview` only for questions about folders
   or application counts, and `waterlooworks_get_document_metadata` only for
   document defaults/packages. These tools are optional and read-only.

Keep search summaries, full posting facts, user-context fit judgments, and
employer analytics separate. Do not imply that an inferred match, a ranking,
or a recommendation came from WaterlooWorks.

## Format the response as a table

For a shortlist, lead with a compact Markdown table. Keep cells concise and
include the posting ID so the user can identify the source posting. A useful
default shape is:

| Rank | Posting (ID) | Employer / location | Term / arrangement | Pay | Deadline | Fit and caveats |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Role (123456) | Organization · City | Term · hybrid | Listed amount | Listed date | Strong: matching skills; verify work authorization |

Adapt columns to the request rather than forcing every field into every table.
For employer comparisons, use a separate table or section so hiring history
and ratings are not confused with posting requirements. After the table, add
only the supporting detail needed to explain the ranking, such as:

- a one-line method note describing which user criteria were applied;
- concise per-posting notes on must-have qualifications, missing information,
  application requirements, or pre-screening questions;
- employer-report notes, explicitly marked as WaterlooWorks history/ratings;
- a short follow-up question asking which postings to inspect more deeply.

Use `Not listed` or `—` for absent fields; do not guess. Use `No employer
report data` for `reportAvailable: false`, not `0` or `Unknown`. Keep long
descriptions and question text out of the main table unless the user asks for
them. If no resume or profile was provided, label fit as preliminary and base
it only on the stated preferences and the posting data.

## Quality and safety checks

- Preserve the distinction between posting facts, employer analytics, and
  your own fit inference.
- Mention material conflicts or unknowns, such as an unlisted salary,
  ambiguous work arrangement, missing qualifications, or a deadline that is
  not present.
- Do not call an employer report repeatedly when WaterlooWorks reports no
  history.
- Do not perform or suggest application submission through this MCP; it is
  read-only.
