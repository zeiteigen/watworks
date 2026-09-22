# Architecture

The first release is intentionally read-only and split into four layers:

```text
Chromium MV3 extension
  cookies permission scoped to WaterlooWorks
          │ Chromium Native Messaging
          ▼
Bun native host / loopback bridge
  127.0.0.1 only; cookies held in memory
          │ HTTP /session and /health
          ▼
WaterlooWorksClient
  authenticated HTTP, bootstrap, action registry, normalization, retry
          │ direct library calls
          ▼
Bun MCP server
  status, search, posting, account, document, and employer-report reads over stdio
```

## Extension

`packages/extension/src/background.ts` connects to the fixed native host name
`com.waterlooworks.mcp`. It calls `chrome.cookies.getAll` with the current
WaterlooWorks jobs URL, filters the result to the WaterlooWorks domain, and
sends a minimal cookie representation to the native host. Using the actual
jobs path also includes cookies scoped below `/myAccount`. It requests no
`<all_urls>` permission and does not read Microsoft, Duo, UWaterloo SSO, or
unrelated cookies.

The extension has no page scraping or job protocol logic. Its service worker is
only a session bridge.

## Native host and local bridge

`packages/bridge/src/native-messaging.ts` implements Chromium’s native
messaging framing: a UTF-8 JSON payload preceded by a four-byte little-endian
length. The host sends a small request to the extension when the client asks
for a refresh, and stores the response only in memory.

`packages/bridge/src/index.ts` binds its HTTP server to `127.0.0.1` and exposes:

- `GET /health` — bridge/session availability metadata;
- `GET /session` — current WaterlooWorks cookies for the local client;
- `GET /session?refresh=1` — asks the extension for a fresh cookie snapshot.

The `/session` endpoint is not an MCP tool and is never returned to an agent.
The bridge logs cookie counts, not values.

## WaterlooWorks client

`packages/waterlooworks-client/src/client.ts` owns all WaterlooWorks HTTP
behavior. It gets sessions through the `SessionProvider` interface, GETs the
current jobs page, parses the current DataViewer configuration, and posts the
semantic search request. The page-generated actions remain in the client’s
private bootstrap state and are represented in logs only by short fingerprints.

The client retries an authentication/protocol failure once by refreshing the
browser session and bootstrapping again. It uses a small concurrency semaphore
and an in-memory posting cache; there is no credential database.

The normalizer converts WaterlooWorks key/value rows, rich posting HTML,
pre-screening HTML, account JSON, document metadata, and employer report
sections into domain models. MCP handlers remove each model’s `raw` field
before returning it.

## MCP

`packages/mcp-server/src/index.ts` is an adapter over the client. It exposes
only semantic read operations in this phase:

- `waterlooworks_status`
- `waterlooworks_search_jobs`
- `waterlooworks_get_search_metadata`
- `waterlooworks_get_job`
- `waterlooworks_get_account_overview`
- `waterlooworks_get_document_metadata`
- `waterlooworks_get_employer_report`

`packages/mcp-server/src/bun-stdio.ts` keeps the process Bun-native while
preserving the official newline-delimited MCP stdio wire format.

The added account operations are read-only. No application submission, folder
mutation, blacklist mutation, document selection, or other consequential
operation is exposed.
