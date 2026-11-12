# WatWorks

This repository is a one-way public mirror of the WatWorks Chrome extension and
the shared code it builds from. Changes are maintained in the upstream source
repository; public commits may be replaced by the next snapshot. Submission
server, hosted proxy, and website source are excluded.

## Install

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

No Bun, Git or LaTeX is needed. To update, download the new ZIP, replace the installed files and reload the
extension once no application is running. Unpacked installs do not update themselves.

## Building from source

Install [Bun](https://bun.sh) 1.4.2 or later and Git, then:

```sh
git clone https://github.com/zeiteigen/watworks.git
cd watworks
bun run setup
```

Load `dist/packages/extension` with **Load unpacked** in `chrome://extensions`
with Developer mode enabled. `bun run update` later downloads the latest version
and rebuilds the extension; it stops without changing anything if you edited
tracked files. Afterwards, reload **WaterlooWorks Workspace** in
`chrome://extensions` (reloading a WaterlooWorks tab is not enough), once no
application is uploading or submitting. `bun run update -- --no-pull` rebuilds
without downloading.

## Development

```sh
bun install --frozen-lockfile
bun run build
bunx playwright install chromium --with-deps
bun test
```

The extension and its shared parsing, validation and document-rendering packages
are included. Personal profiles, resumes, application records, cookies, build
output, and server implementation are excluded.

## Extension downloads

Signed CRX, unpacked ZIP, and checksums are available from
[GitHub Releases](https://github.com/zeiteigen/watworks/releases). For Windows
and macOS developer installs, extract the ZIP and load its folder unpacked.
Chrome normally requires Web Store distribution for packed extensions there.
The latest release refreshes automatically after validated public `main` updates;
versioned `extension-v<version>` releases are also available.

The signing identity is `onlcepldlajaajfjldnbipkbffaficjh`. If updating from the
older unpacked ID, reinstall the extension when no application is active, then
sign in again.
