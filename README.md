An MCP server that allows an agent to find the jobs that best suit you on WaterlooWorks.

Reuses the authenticated session from an existing Chromium browser profile. It does not
automate Waterloo/Microsoft/Duo login and does not ask for a password.

# Installation

## Requirements

- Bun 1.4+.
- Chromium or Chrome.
- An existing authenticated WaterlooWorks browser profile.

## Build the extension and native host

Build the unpacked MV3 extension and a Bun-compiled native host:

```sh
bun run build:extension
bun run build:bridge
```

The extension output is `packages/extension/dist`. The native host binary is
`dist/waterlooworks-bridge`.

1. Open `chrome://extensions` (or the Chromium equivalent), enable Developer
   mode, choose **Load unpacked**, and select the absolute path to
   `packages/extension/dist`.
2. Copy `packages/bridge/native-host-manifest.example.json` to the browser’s
   per-user Native Messaging Hosts directory:
   - Chrome on Linux: `~/.config/google-chrome/NativeMessagingHosts/`
   - Chromium on Linux: `~/.config/chromium/NativeMessagingHosts/`

   Name the copy `com.waterlooworks.mcp.json`.

3. Replace the manifest `path` with the absolute path to the compiled binary.
4. Replace `REPLACE_WITH_THE_EXTENSION_ID` with the ID shown on the extension
   card. Keep the trailing slash in `allowed_origins`.
5. Reload the extension and open/reload the WaterlooWorks jobs page in the same
   authenticated profile.

The native host is started by the extension. It listens only on
`127.0.0.1:39451` by default. Set `WATERLOOWORKS_BRIDGE_PORT` consistently if
that port is unavailable.

## Run the MCP server

Add as stdio in your agent interface.

CWD: where this project is installed
Command: "bun"
Args: ["run", "start:mcp"]

## Add the agent skill (Optional, Recommended)

This repository includes the skill at `./skill`. Drag the directory into your skills folder.

Helps guide the agent in using the MCP Server, analysing data, and asking you the right questions

# Project layout

```text
packages/
  extension/              MV3 session-only extension
  bridge/                 Native Messaging host and loopback bridge
  waterlooworks-client/   HTTP protocol client and domain models
  mcp-server/             Thin agent-facing adapter
docs/protocol.md          Observed/inferred/unknown protocol record
docs/architecture.md      Layer boundaries and security model
```
