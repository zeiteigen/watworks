# WaterlooWorks protocol notes

This document records what is supported by the available protocol evidence and
what is only a hypothesis. Opaque `action` values are intentionally omitted
from this repository.

## Scope and terminology

The relevant page is:

```text
https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm
```

`action` is a form parameter, not an HTTP header. The implementation treats it
as page-generated operation state and discovers it again after bootstrap.

## Observed: initial jobs page

- The initial request is `GET /myAccount/co-op/full/jobs.htm`.
- The response status is `200`.
- The response content type is `text/html`.
- The response contains the jobs DataViewer setup.
- The page source contains a `dataViewerProps` object whose `dataParams`
  contains an opaque `action` and `isDataViewer: true`.
- The page source also contains the default sort:
  `[{key: "Id", direction: "desc"}]`.

The body is an HTML document containing inline JavaScript. It is not safe to
assume that a page-generated action value is reusable across sessions or future
page loads.

## Observed: job DataViewer search

Representative search requests are POSTs to the same URL. They use the same
page-generated action value and the same parameter names:

```text
page
sort
itemsPerPage
filters
columns
keyword
action
isDataViewer
```

The request is form encoded. It includes:

```text
page=1
itemsPerPage=50
filters=null
sort=[{"key":"Id","direction":"desc"}]
isDataViewer=true
```

For an empty search, `keyword` is an empty string. For a keyword search, the
URL/form-decoded value has this shape:

```json
[{ "value": "example-keyword", "op": "all" }]
```

The `columns` value is URL/form encoded JSON. The observed column keys are:

```text
Id
JobTitle
Organization
Division
Openings
City
Level
ApplicationCount
Deadline
```

The column metadata also contains a custom `JobTitle` visualizer. The client
retains the JSON-visible visualizer portion as a bootstrap-derived/default
protocol value, while allowing it to be replaced if the page supplies a
different list. `scripts/verify-har.ts` confirms that the resulting `columns`
payload matches the recorded jobs-search request shape exactly.

## Observed: job search response

The server labels these responses as `text/html`, but their bodies are JSON
objects with these top-level keys:

```text
totalResults
data
page
```

The response includes a total result count, a page of rows, and the requested
page number. Result counts are runtime data, not stable application constants.

Each observed row has an `id` and a `data` array of key/value objects. The
observed fields include:

```text
postingId
Id
JobTitle
Organization
Division
Openings
City
Level
ApplicationCount
Deadline
deadline
canApply
hasApplication
online
apply
```

`JobTitle.value` is an object. It contains at least
`postingTitle`, `new`, `featured`, `applied`, and `viewed`; some rows may carry
additional presentation fields. The normalizer must not assume that every
field is present.

## Observed: additional requests from the same page

The following request groups are identified from page source and callback
behavior; these labels are not a claim that the server-side operation names
are public or stable.

| Evidence                         | Action value   | Form shape                            | Response shape                   | Current interpretation                      |
| -------------------------------- | -------------- | ------------------------------------- | -------------------------------- | ------------------------------------------- |
| Main jobs DataViewer search      | page-generated | DataViewer search fields              | `{totalResults,data,page}`       | Main jobs search                            |
| Folder-list callback             | page-generated | `action`                              | array                            | Main-app folder list                        |
| Folder-postings callback         | page-generated | `action`                              | object                           | Main-app postings-in-folders map            |
| Blacklist callback               | page-generated | `action`                              | array                            | Main-app blacklisted postings               |
| Default-documents callback       | page-generated | `action`                              | object with document keys        | Default document metadata                   |
| Empty-state folder callback      | page-generated | `action`                              | array                            | Empty-state folder list                     |
| Folder-count callback            | page-generated | `action`                              | small object/primitive-like JSON | Folder counts (inferred from callback)      |
| Statistics callback              | page-generated | `selectedTerm`, `numOfDays`, `action` | `{applicationCount}`             | Statistics/application count                |
| UI state update                  | none           | `setProperty`, `setPropertyState`     | full HTML page                   | UI state update, not a DataViewer operation |

The two folder-list actions are different values in different page
components. They are deliberately kept separate until later evidence proves
that they are equivalent.

## Observed from page source: posting retrieval

The jobs page source defines these functions, each issuing a POST to
`/myAccount/co-op/full/jobs.htm`:

```text
getPostingData(postingId)
getPostingOverview(postingId)
getPostingPreScreening(postingId)
```

Each request has `action` and `postingId`. The page uses them when a DataViewer
row is opened. Their page-generated action values are discovered during
bootstrap and are omitted here.

A supplemental example covered all three responses for a sample posting.
`getPostingData` returns structured status, tags, locations, geodata, division
ID, pre-screening presence, and application state. `getPostingOverview` returns
rich HTML containing work-term, job, location, description, skills,
compensation, targeted disciplines, application requirements, application
method, company information, and service-team details. `getPostingPreScreening`
returns question HTML with answer choices. Actions are still discovered from
the freshly bootstrapped page and are never hard-coded.

The posting template itself observes these fields on the `getPostingData`
result: `id`, `position`, `org`, `div`, `tags`, `hasPreScreening`, `geoData`,
`defaultLocations`, `qualifiers`, `divId`, `t99`, and `applicationData`.
Within `applicationData`, the template reads `canApply`, `hasApplication`,
`canCancelApplication`, and `website`. These are source-observed field names;
the supplemental response confirms the corresponding boolean values and may
still omit optional fields on other postings.

## Supplemental read-only account and employer data

The supplemental page defines read-only callbacks for folders, postings in
folders, blacklisted postings, folder counts, application statistics, default
documents, and employer hiring-history reports. The response shapes include:

- folders: array;
- postings in folders: object keyed by folder ID;
- blacklisted postings: array;
- folder counts: object keyed by folder ID;
- application statistics: `{applicationCount}`;
- default documents: document types, defaults, special documents, and module
  URL;
- employer report: typed text, table, pie-chart, and bar-chart sections.

Employer reports may also contain a work-term-ratings table, an overall
satisfaction distribution column chart, and a per-question average-rating
mixed chart. These are retained in `sections` and exposed through named
analytics fields by the client.

For employers without hiring-history/work-term-ratings data, the same report
operation can return a JSON object containing a `missingReportStructure` marker
instead of `sections`. The client treats that as a valid no-data response and
normalizes it to `reportAvailable: false` with an empty `sections` array.

The page also exposes 39 DataViewer filter definitions, including keyword,
viewed/new/deadline states, targeted disciplines, folders, blacklist state,
level, location, organization, work term, duration, qualifications,
compensation, program, and other posting fields. The client returns these
definitions through `waterlooworks_get_search_metadata` and accepts their
values through `waterlooworks_search_jobs.filters`.

## Observed from page source: application-related operations

The page source contains code for creating an application, expressing an
intention to apply, cancelling an application, and printing a posting. Those
operations were not exercised in the available protocol evidence. They are out of scope for
the first read-only release and must not be exposed as MCP tools yet.

## Inferred

- `action` likely dispatches a server-side operation selected by the current
  page/component.
- The action is at least page-generated because the page embeds it in
  `dataViewerProps` and embeds different values for other operations.
- The DataViewer POST body is a stable-enough starting shape for this client,
  but the server may validate additional session or page state.
- A successful HTTP 200 is not sufficient to establish success: a logged-out
  page or an application-level error may also be returned with status 200.
- `getPostingData` is the structured metadata endpoint and
  `getPostingOverview` is the HTML rich-text description endpoint for the
  sample posting. Individual postings may still omit optional fields.

## Unknown

- Whether action values are session-bound, page-load-bound, time-bound, signed,
  or reusable for more than one request.
- Whether cookies from Microsoft, Duo, or another UWaterloo SSO host are needed.
  The first bridge therefore exports only WaterlooWorks-domain cookies.
- The exact authenticated-vs-logged-out markers for every failure path.
- Whether every posting supplies the same optional detail fields and HTML
  sections as the supplemental posting.
- Whether the two folder-list operations have identical semantics.
- Pagination limits and server-side rate limits.
- Whether a posting can disappear between search and retrieval.

## Implementation consequences

1. Bootstrap must GET the current jobs page before making DataViewer requests.
2. Actions must be discovered and kept in a semantic operation registry; no
   opaque action is hard-coded.
3. Search response parsing must accept JSON bodies even when the response MIME
   type says `text/html`.
4. Authentication, HTTP errors, protocol parsing errors, and application-level
   errors must remain distinguishable.
5. The MCP surface remains read-only: status, search, posting retrieval,
   account metadata, document metadata, and employer reports. Application and
   account mutations remain disabled until they have dedicated evidence and
   explicit approval flows.
