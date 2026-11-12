# WatWorks

This repository is a one-way public mirror of the local workspace and Chrome
extension. Changes are maintained in the upstream source repository; public
commits may be replaced by the next snapshot. Submission server, hosted proxy,
and website source are excluded.

## Hosted workspace (recommended)

Download the ZIP from the [latest extension release](https://github.com/zeiteigen/watworks/releases/tag/extension-latest),
extract it to a permanent folder, and load the folder containing `manifest.json`
through **Load unpacked** in `chrome://extensions` with Developer mode enabled.
Sign in to WaterlooWorks in the same profile, then open the extension and choose
**Open dashboard**. Hosted access is invite-only through Insider grants.

Complete Setup with your ChatGPT connection or supported provider API key,
preferences and PDF resumes. Launch a search or let the daily search run; keep
Chrome running so the extension can refresh your session when needed. Home walks
you through reviewing screening answers, resume changes, cover letters and the
final application. Uploads and submissions require your review clicks. Uncertain
writes are never retried automatically; external employer-site steps remain yours
to complete. Hosted profile and materials are stored on the service, and relevant
application data is sent to your connected AI provider.

No Bun, Git, local agent, LaTeX or native startup helper is needed for this path.
To update, download the new ZIP, replace the installed files and reload the
extension once no application is running. Unpacked installs do not update themselves.

## Advanced local setup

The popup's `debug` shortcut reveals the local workspace tools.

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

Open **Advanced local dashboard** from the extension to review materials and approve applications.
Applying and scheduled discovery require a configured [submission service](docs/submission-server.md).
Local research and document preparation use your signed-in browser.
Agents must never approve applications or operate dashboard approval controls.

## Updating the local workspace

```sh
bun run update
```

This downloads the latest version, reinstalls dependencies and rebuilds
`dist/packages/extension`. It stops without changing anything if you edited
tracked files, and never touches `data/`. Afterwards, reload **WaterlooWorks
Workspace** in `chrome://extensions` (reloading a WaterlooWorks tab is not
enough) and restart Claude Code or Codex. Wait until no application is uploading
or submitting first. `bun run update -- --no-pull` rebuilds without downloading;
`--latex` also refreshes LaTeX.

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

## Extension downloads

Signed CRX, unpacked ZIP, and checksums are available from
[GitHub Releases](https://github.com/zeiteigen/watworks/releases). For Windows
and macOS developer installs, extract the ZIP and load its folder unpacked.
Chrome normally requires Web Store distribution for packed extensions there.
Only the advanced local workspace and native startup helper require `bun run setup`.
The latest release refreshes automatically after validated public `main` updates;
versioned `extension-v<version>` releases are also available.

The signing identity is `onlcepldlajaajfjldnbipkbffaficjh`. If updating from the
older unpacked ID, update your workspace, run setup, reinstall the extension,
and restart the local service when no application is active. Sign in and
configure the new extension again; your local `data/` workspace stays in place.
