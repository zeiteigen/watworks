# WaterlooWorks local workspace and Chrome extension

This repository is a one-way public mirror of the local workspace and Chrome
extension. Changes are maintained in the upstream source repository; public
commits may be replaced by the next snapshot. Submission server, hosted proxy,
and website source are excluded.

## Setup

Install [Bun](https://bun.sh) 1.4.2 or later, Git, and a Chromium-based browser.

```sh
git clone https://github.com/zeiteigen/watworks.git
cd watworks
bun run setup
```

Load `dist/packages/extension` with **Load unpacked** in `chrome://extensions`
with Developer mode enabled. Open the popup and sign in to WaterlooWorks.
Setup installs the native startup helper, prepares LaTeX, and creates the private
`data/` workspace. Run `bun run setup -- --skip-latex` to skip the LaTeX download.

Start Claude Code or Codex from this directory and trust the project's MCP
configuration. Run `/onboard` (Codex: `$onboard`), then `/job-search`
(Codex: `$job-search`) to prepare applications. `/apply-job` prepares one posting;
`/create-job-doc` and `/tailor-resume` manage application materials.

Open Dashboard from the extension to review materials and approve applications.
Applying and scheduled discovery require a configured [submission service](docs/submission-server.md).
Local research and document preparation use your signed-in browser.
Agents must never approve applications or operate dashboard approval controls.

## Development

```sh
bun install --frozen-lockfile
bun run build
bunx playwright install chromium --with-deps
bun test
```

The extension dashboard, local MCP server, workspace, native startup helper, and
shared parsing/validation packages are included. Personal profiles, resumes,
application records, cookies, build output, and server implementation are excluded.
Runtime workspace files live in gitignored `data/`.
