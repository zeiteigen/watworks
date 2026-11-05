---
name: onboard
description: First-run onboarding for this job-application workspace. Sets up the project, connects the WaterlooWorks browser session, collects the user's master experience draft, target roles, work authorization, and preferences, then generates one tailored one-page resume PDF per target role using Jake's LaTeX template. Use when the user says onboard, set up, get started, or when workspace_status shows a missing profile.
metadata:
  short-description: Set up the workspace, profile, and tailored resumes
---

# Onboard

Goal: by the end, `workspace_status` shows a saved profile, a saved experience
draft, a compiled one-page resume for every target, and a connected
WaterlooWorks session. The user should then run `/job-search` (Codex:
`$job-search`).

All data lives in `data/` and is written only through the workspace MCP tools.
Do not hand-write files in `data/` except when the user asks you to edit their
LaTeX templates in `data/templates/`.

The browser extension owns local research, sign-in detection, and parsing.
Application reads and Playwright UI writes run on the configured submission
server. On application preparation or discovery demand, WaterlooWorks cookies and the
browser user agent transfer directly to the configured endpoint; cookies
never pass through the local
broker, dashboard, or agent. There is no pairing flow. The dashboard is an
extension page backed by `http://127.0.0.1:39452/`; return its URL to the user
but never open it or call its routes. Build and load the extension unpacked from the
local checkout; it is not published or store-distributed.

## 0. Check where the user is

Call `workspace_status`. Skip any step that is already done, and tell the user
what is already in place. If the MCP tools are unavailable, go to step 1.

## 1. Project setup

If the `waterlooworks` MCP tools are missing, or `workspace_status.latex`
reports missing, run `bun run setup` from the project root. It installs
dependencies, builds the browser extension, installs Tectonic (LaTeX), and
creates `data/`. If MCP tools were missing, ask the user to reconnect the MCP
server (Claude Code: `/mcp`; Codex: restart `codex`) and continue.

## 2. Connect WaterlooWorks

Call `waterlooworks_status`. If `bridgeConnected` or `authenticated` is false,
walk the user through:

1. Open `chrome://extensions` in a Chromium browser, enable Developer mode,
   click **Load unpacked**, and select `dist/packages/extension` in this project.
2. Sign in to https://waterlooworks.uwaterloo.ca in that browser.

Recheck until `authenticated`, `bridgeConnected`, and `bootstrapped` are all
true. Never ask for passwords, cookies, or tokens. This step can be deferred
if the user wants to build resumes first.

Application preparation and submission also need a configured submission server.
Point the user to `docs/submission-server.md` and the extension’s Submission
server settings. The user saves the endpoint, grants host permission, configures
proxy authentication headers if required. Session transfer happens automatically
when application preparation or discovery needs it; passive polling stays passive.
Endpoint or proxy-setting changes invalidate the prior session binding. This never
authorizes retrying a failed mutation. Local research remains available independently.

## 3. Experience draft (the source of truth)

Ask the user for their master experience document: every job, project,
achievement, and skill in as much detail as they have. Accept either:

- a file path: call `experience_save` with `importPath` (absolute path), or
- pasted text or an existing resume: call `experience_save` with `markdown`.

If they only have a short resume, ask follow-up questions about each role and
project (scope, technologies, measurable results) and save the richer Markdown.
Everything you later put in a resume or cover letter must trace back to this
draft or the profile. Never invent experience, metrics, or skills.

## 4. Profile

Ask concisely, in one or two rounds, then call `profile_save`:

- **Contact:** name, email, phone (optional), location, links (GitHub, LinkedIn, portfolio).
- **Education:** institution, program, current term (for example 3A), dates.
- **Work authorization:** Canada status, US status, whether sponsorship is
  needed in each, and any other countries. These answers drive which postings
  are skipped and how screening questions are answered, so get them exactly.
  For a Canadian citizen, record `canada: "citizen"` and
  `needsSponsorship.canada: false`. Do not assume any US status: ask, and if
  they hold no US citizenship or green card, record `unitedStates: "none"` and
  `needsSponsorship.unitedStates: true` (US co-op terms usually need a J-1).
  Ask whether they hold any security clearance and record it in `notes`.
  The full rules are in the `job-search` skill under "Work authorization for
  Canadian citizens".
- **Targets:** the kinds of roles they want (for example "ML research",
  "backend", "embedded/firmware"). Each target needs an `id`, a `label`,
  search `keywords`, and a `resumeVariant` id. Targets can share a variant.
- **Preferences:** locations, on-site/hybrid/remote, terms, minimum hourly
  pay, employers or keywords to avoid.
- **Standard answers:** reusable answers to common screening questions
  (for example "Are you legally eligible to work in Canada?", "Earliest start
  date", "Willing to relocate?"). Only record answers the user gives.

If `profile_save` returns validation errors, fix them and save again.

## 5. Tailored resumes

For each distinct `resumeVariant` in the targets:

1. Choose the most relevant experience, projects, and skills from the draft
   for that target. Reorder and rephrase bullets to emphasize relevant work,
   using strong verbs and concrete results from the draft.
2. Call `resume_save_variant` with a `ResumeDocument` (heading, then sections:
   education, experience, projects, skills). `**bold**` is allowed in bullets.
3. If `pages` is greater than 1, cut the weakest bullets or projects and save
   again. Keep each resume to exactly one page.

Each newly created resume PDF opens automatically (`opened: true`). Show
the user the list of PDFs (`resume_list`) and ask them to review each one. Apply their edits with `resume_save_variant`.

The layout comes from `data/templates/resume.tex` (Jake's Resume by default).
If the user wants a different look, edit that file's preamble or macro
definitions, keeping the macro names and the `%%WAT:BODY%%` line, then
re-save each variant to recompile.

## 6. Finish

Call `workspace_status` and summarize what is ready. Tell the user to run
`/job-search` (Codex: `$job-search`) next.
