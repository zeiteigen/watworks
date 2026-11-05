# data/

Your personal job-search workspace. Everything here except this README is
gitignored. The workspace MCP tools write these files, and the layout is
defined in `packages/workspace/src/paths.ts`.

```
profile/profile.json        contact, education, work authorization, targets, preferences, standard answers
profile/experience.md       your master experience draft (source of truth for every resume)
templates/resume.tex        your editable copy of Jake's Resume
templates/cover-letter.tex  your editable cover letter template
templates/document.tex      your editable template for other job documents
resumes/<variant>/          resume.json (content), resume.tex, resume.pdf, upload.json
jobs/<source>/<jobId>/      posting.json, description.md, form.json, plan.json,
                            cover-letter.json/.tex/.pdf, documents/<id>.json/.tex/.pdf,
                            status.json
searches/                   one JSON record per search
```

Set `WAT_DATA_DIR` to an absolute path to keep this data somewhere else.
