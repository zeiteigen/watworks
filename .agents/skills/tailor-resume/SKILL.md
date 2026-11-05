---
name: tailor-resume
description: Create or revise one tailored resume variant (or the LaTeX resume template) from the user's saved experience draft, compile it to a one-page PDF, and optionally re-plan ready jobs that use it. Use when the user wants to edit, add, or restyle a resume after onboarding.
metadata:
  short-description: Create or revise a tailored resume variant
---

# Tailor a resume

The token-free dashboard at `http://127.0.0.1:39452/` shows generated resume
PDFs and jobs. `dashboard_open` returns the URL for the user; never open the
dashboard or call its HTTP routes. The unpacked browser extension owns local
WaterlooWorks research and sign-in. Application reads and Playwright UI writes
belong to the configured submission server. Session transfer to the configured endpoint happens automatically when application
preparation or discovery needs a session; passive polling stays passive. No live application write is established by this workflow.

1. Call `profile_get` (experience draft and targets) and `resume_list`.
2. Ask which variant to change or create, and what to emphasize. A specific
   posting can be the target. If so, read its `description.md` from
   `jobs_list`/`job_save`.
3. Build the `ResumeDocument` from the experience draft only. Never invent
   experience, metrics, or skills. `**bold**` is allowed in bullets.
4. Call `resume_save_variant`. If `pages` is greater than 1, trim and save again.
5. To restyle every resume, edit `data/templates/resume.tex` (preamble and
   macro bodies only; keep the macro names and the `%%WAT:BODY%%` line), then
   re-save each variant from `resume_list` to recompile.
6. When a variant changes, jobs that use it stay `ready`. The dashboard shows
   the new PDF, and it is uploaded to WaterlooWorks again on the next apply.
   Mention this to the user.
