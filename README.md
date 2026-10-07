# Sentry Power (read-only)

Pull Sentry crash context into Kiro over the Sentry REST API. It runs a small
local MCP server and uses your own Sentry user auth token, so it reads exactly
what your own account can already see.

## What it can do

**Strictly read-only.** It performs HTTP GET requests only and has no ability to
resolve, ignore, assign, comment on, delete, or otherwise modify anything in
Sentry. This is enforced by construction: the client exposes a single GET helper
and that is the only place in the server that calls `fetch`, so there is no code
path that could issue a POST, PUT, PATCH or DELETE.

| Tool | What it does |
|---|---|
| `list_projects` | List the organization's projects with slugs, names and platforms. The slug is what `search_issues` filters on. |
| `search_issues` | Search issues with Sentry search syntax (default `is:unresolved`, default window `14d`). Returns a capped list with event and user counts; **does not save anything to disk**. |
| `search_logs` | Search structured Logs (Sentry's **Explore > Logs**) with Sentry search syntax. Default window `24h`. Follows result pages to pull every matching row up to `limit` (default and max 5000), **always writes them oldest first to a Serilog-style `.log` file** under `<workspace>/.sentry/logs/` (see below), and returns the saved path plus whether the full set was retrieved or the ceiling was hit. Log lines are not echoed into chat. |
| `get_issue` | Fetch one issue by numeric id or short id (e.g. `MYAPP-4F2`) plus its latest event, and save it to `.sentry/<ID>/` in your workspace (see below). Returns the summary plus where it was saved. |
| `get_event` | Fetch one event (`latest`, `oldest`, `recommended`, or a specific id) and render the exception chain, stack frames, breadcrumbs and tags. Saves nothing. |
| `get_issue_tags` | Tag breakdown for an issue: every key with its top values and counts, or a single key in detail. |

## Sentry Logs are a separate dataset

`search_logs` reads Sentry's structured **Logs**, which is a different dataset
from issues and events. Issues answer "what broke"; logs answer "what was
happening for this user, driver, order or trace". A log row is not attached to an
issue, so nothing found here has a stack trace - to pivot across to the matching
issue or event, search by trace (`trace:<id>`) on either side.

What the query argument accepts:

- Raw text matches the `message` attribute and **is case sensitive**. Quote a
  phrase to match it as a whole, e.g. `"API call attempted while offline"`.
- `severity:error` (also `warn`, `info`, `debug`), and the `severity` argument is
  a convenience that is folded into the query as `severity:<value>`; it composes
  with your query rather than replacing it.
- `trace:abc123...`, `environment:PROD_BFF`, `release:1.2.3`.
- Any custom log attribute your app sets, e.g. `DriverId:15744`,
  `order.id:order_123`, plus `has:<attribute>` to require one.
- `user.id` is accepted by the API but is **not** populated on log rows - user
  identity in logs arrives as whatever custom attribute your app logs.

Other behaviour worth knowing:

- `project` takes a slug **or** a numeric id and is passed to Sentry verbatim, so
  no extra project lookup happens.
- `statsPeriod` defaults to `24h`. Longer windows including `90d` are accepted,
  but logs have their own retention, so a long window can only reach as far back
  as your plan keeps logs.
- `limit` is the **total** across pages, default and max **5000**. The power
  requests pages of 100 (Sentry's `per_page` max) and follows the `rel="next"`
  cursor, stopping at `limit`, at 50 pages, or when results run out. The
  response and the file header both say `complete` (every matching row is in the
  file) or `capped` (more rows exist beyond the ceiling - narrow the query or
  window to get the rest), naming which ceiling was hit. Nothing is dropped
  silently.
- Sentry pages by offset, so on a busy project new log rows arriving during the
  walk push earlier rows onto the next page. Those repeats are dropped by row id,
  which means a very busy window can reach the 50-page ceiling with fewer than
  `limit` rows; the status then says `capped` at the page ceiling.
- `sort` decides which rows Sentry pages through first, so with the default
  `-timestamp` a capped search keeps the newest 5000. The saved file is always
  written oldest first whatever `sort` is.
- Scope-wise nothing changes: the existing `org:read` on your token is enough.

### Log searches are saved as .log files

Every `search_logs` call writes its full result to a new file:

```
<workspace>/.sentry/logs/<project>_<query>_<yyyy-MM-ddTHHmmZ>.log
```

for example `pingo-dotnet-xamarin_DriverId-14429_2026-10-07T0738Z.log`. The
project and the effective query (including a folded-in `severity`) have anything
outside `A-Z a-z 0-9 . _ -` replaced with `-`, runs collapsed and each part
capped at 60 characters. An empty query becomes `all` and no project becomes
`all-projects`. The time is UTC. A second search in the same minute gets `-2`,
`-3` and so on rather than overwriting the first.

The file opens with a header block, every line prefixed `# ` so it never reads as
a log entry: organization, project, the exact query, severity, environment,
`statsPeriod` and the resolved UTC window, request sort, requested limit, pages
fetched, row count, `complete` or `capped` status, the projects, environments and
releases seen, and the generation time. Then one entry per line, oldest first,
in the same shape as the app's device logs:

```
[2026-10-07 09:03:48.454 DBG] CheckNotification called
[2026-10-07 09:03:48.478 INF] PushDelegate: finished handling push action 'TripNotification'
```

- Times are UTC, `yyyy-MM-dd HH:mm:ss.fff`, with milliseconds taken from Sentry's
  `timestamp_precise`.
- Embedded newlines in a message are replaced with spaces so each entry stays on
  one line. The message is otherwise written as Sentry returned it.
- `trace`, `environment` and `release` are not written on each line, so the file
  matches the device-log shape. The header lists the projects, environments and
  releases seen. Trace ids are not in the file; when you have one from an issue
  or event, `search_logs { "query": "trace:<id>" }` pulls that trace's rows.

| Sentry severity | Level written |
|---|---|
| `trace`, `verbose` | `VRB` |
| `debug` | `DBG` |
| `info`, `information` | `INF` |
| `warn`, `warning` | `WRN` |
| `error` | `ERR` |
| `fatal`, `critical` | `FTL` |
| anything else, or missing | `INF` |

Log files use the same workspace detection and data-folder fallback as issues
(below), landing in `~/.kiro/powers/data/kiro-power-sentry/logs/` when no
workspace is detected, and are git-ignored by the same `.sentry/.gitignore`.

## Fetched issues are saved into your workspace

Whenever an issue is fetched with `get_issue`, the power writes it into a
`.sentry` folder in the workspace you have open, so it shows up in your file tree.
`search_logs` writes its `.log` files alongside, under `logs/`. `search_issues`,
`get_event` and `get_issue_tags` are read-through only and save nothing:

```
<workspace>/.sentry/
  .gitignore              # ignores everything here, so issues and logs are never committed
  <ISSUE-ID>/
    <ISSUE-ID>.md         # issue details plus the latest event, as Markdown
  logs/
    <project>_<query>_<time>.log   # one file per search_logs call
```

The Markdown captures the issue fields (title, short id, project, level, status,
culprit, permalink, event and user counts, first and last seen, release), its
metadata and annotations, and the latest event in full: the exception chain, the
stack frames, the breadcrumbs, and the whole tag set including device, OS, app
version and environment. Re-fetching an issue rewrites the file with the latest
data.

A `.gitignore` is created inside `.sentry` on first use so issue data stays local
and is never committed.

### How the workspace is detected

A power's MCP server is launched with its working directory set to the plugin
root and receives no workspace path, so the power reads Kiro's own window state
file to find the folder you have open. Two consequences worth knowing:

- If **several** workspace windows are open, the power cannot tell which one the
  request came from. It uses the active window, or otherwise the most recently
  opened folder, and reports `locationAssumed: true` with the reason so you can
  see the assumption it made.
- If the workspace cannot be determined at all, the issue is saved under the
  power's data folder (`~/.kiro/powers/data/kiro-power-sentry/`) instead, and the
  response says so. Nothing is lost.

Detection relies on Kiro's internal window state file rather than a documented
API, so a future Kiro change could break it - in which case saving falls back to
the data folder as above.

## Stack traces are shown as returned

Frames are printed exactly as the Sentry API returned them, in payload order and
numbered, under a heading stating that the most recent call is listed last.
There is **no symbolication, no dSYM or ProGuard mapping, and no frame
resolution** anywhere in this power. If names come back obfuscated or line
numbers are missing, that is what the event payload contained; the mapping files
have to be uploaded to Sentry itself.

## Prerequisites

- **Node.js 18+** (`node --version`). Node 22+ is recommended - see
  [corporate networks](#connection-fails-with-a-certificate-error-corporate-networks).
- A Sentry account with access to the organization and projects you want to read.

The power ships a prebuilt, self-contained server bundle
(`server/dist/index.js`), so there is **no `npm install`** and no dependencies to
fetch - it runs as soon as the power is installed.

## Setup

### 1. Let the server create your config file

Just start the power. On first run the server **creates an empty config file
automatically** at:

```
~/.kiro/powers/data/kiro-power-sentry/config.json
```

and reports it:

```
Created a new config file at C:\Users\you\.kiro\powers\data\kiro-power-sentry\config.json.
Open it and fill in:
  baseUrl        - your Sentry host, defaults to https://sentry.io (change only for self-hosted)
  organization   - your Sentry organization slug, e.g. your-org-slug
  authToken      - a Sentry user auth token with the read scopes event:read, project:read, org:read (https://docs.sentry.io/api/permissions/)
  defaultProject - optional project slug used as the default filter for search_issues
Then reconnect the sentry server.
```

### 2. Fill in your values

Open that file and complete it:

```json
{
  "baseUrl": "https://sentry.io",
  "organization": "your-org-slug",
  "authToken": "your-auth-token",
  "defaultProject": "optional-project-slug"
}
```

- `baseUrl` defaults to `https://sentry.io` and only needs changing for
  self-hosted Sentry. It must be `https`.
- `organization` and `authToken` are required.
- `defaultProject` is optional. When set, `search_issues` filters on it unless
  you pass a `project` explicitly.

Create a **user auth token** in Sentry under your account settings, with the read
scopes `event:read`, `project:read` and `org:read`. The scopes are documented at
[Sentry API permissions](https://docs.sentry.io/api/permissions/). No write
scopes are needed - the power cannot use them.

### 3. Reconnect

Reconnect the `sentry` server in Kiro's **MCP Servers** panel (or restart Kiro).
The six tools become available.

## Where the config file lives

There is exactly one location, always:

```
~/.kiro/powers/data/kiro-power-sentry/config.json
```

On Windows that is `C:\Users\<you>\.kiro\powers\data\kiro-power-sentry\config.json`.

This is the only file the power reads or writes. There are no fallback locations
and no environment-variable alternatives, so there is never any question about
which file is in use.

It sits **outside** the power directory on purpose:

- The **installed** power folder is deleted and recopied on every update, which
  would wipe your credentials.
- The **source** power folder is what gets published, so a config file there
  would ship personal data to everyone who installs the power.

## Verifying it works

1. Open Kiro's **Powers** panel, choose **Add Custom Power**, then **Local
   Directory**, and point it at the folder you cloned this repository into.
2. Let the server start once so it creates the config file, then fill in
   `organization` and `authToken` as above.
3. Reconnect the `sentry` server in Kiro's **MCP Servers** panel. It should
   connect and list `list_projects`, `search_issues`, `search_logs`, `get_issue`,
   `get_event` and `get_issue_tags`.
4. Ask Kiro to list your Sentry projects. You should get a table of slugs.
5. Ask Kiro to search a project for unresolved issues, e.g. "search Sentry for
   unresolved issues in my-android-app". Confirm the issues listed are the ones
   you expect, and that the project filter took effect.
6. Ask Kiro to fetch a known issue by its short id, e.g. "get Sentry issue
   MYAPP-4F2". Confirm the response names a saved Markdown path, and open that
   file to check the stack trace is present and readable.
7. Ask Kiro for that issue's tags, e.g. "show the os.name tag for MYAPP-4F2".
8. Ask Kiro for today's Sentry logs, e.g. "get today's Sentry logs for
   my-android-app". The response names a saved `.log` path, the row count, and
   whether the result is `complete` or `capped`. Open the file and check the
   `[yyyy-MM-dd HH:mm:ss.fff INF] ...` lines run oldest first. If no rows come
   back, widen `statsPeriod` before suspecting the query - the default window is
   only `24h`.

If the server reports missing values, re-check the config file path from the
error message and that `organization` and `authToken` are both filled in.

## Troubleshooting

### Connection fails with a certificate error (corporate networks)

If the server connects but Sentry calls fail with `SELF_SIGNED_CERT_IN_CHAIN`,
your network performs TLS inspection: it re-signs HTTPS traffic with an internal
root CA. That CA is trusted by the OS, but Node ships its own CA list and
ignores the OS trust store by default.

The server handles this: on startup it merges the OS certificate store with
Node's bundled CAs (see `server/src/trust-system-ca.js`), with full certificate
validation left on. It is a no-op on networks without an inspecting proxy.

This runtime CA merge needs **Node 22+**. On older Node, either upgrade, or set
one of these before launching Kiro:

- `NODE_OPTIONS=--use-system-ca` - read the OS trust store, or
- `NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem` - point at the exported CA.

Do **not** use `NODE_TLS_REJECT_UNAUTHORIZED=0` - it disables certificate
validation entirely.

### 401, 403, 404 and 429

- **401** - the auth token is invalid, expired or revoked. Re-check `authToken`
  in the config file and reconnect the server.
- **403** - the token is missing a scope. The message names the scope the
  endpoint needs; add it to the token and reconnect.
- **404** - the organization slug, project slug, issue id or event id does not
  exist or is not visible to that token. Run `list_projects` to see what the
  token can actually reach.
- **429** - Sentry rate limited the request. The message includes `Retry-After`
  when Sentry sends it; wait that long and retry.

### Seeing the real error

Kiro shows a short message on failure. To see the underlying cause, run the
bundled server directly:

```bash
cd server
node dist/index.js
```

A clean start prints `[sentry] read-only MCP server started`. A configuration
problem exits immediately with a message naming the file and the missing fields.

## Security notes

- The server is GET-only by construction; there is no code path that writes to
  Sentry.
- The token grants only your own Sentry read access - this power can read only
  what your account can already see, and no write scopes are required.
- The token lives in your own config file, outside the power directory, so the
  published package contains no credentials.
- The token is never echoed into a tool response, a log line, or a saved file;
  anything built from an API error body has it redacted first.
- Fetched issues and log searches are saved under `.sentry/` in your workspace
  (git-ignored). Delete that folder any time; it is just local cache.
- A saved `.log` file is built only from the returned log rows and the search
  parameters, never from the token or request headers.

## Building from source (maintainers)

The power ships the prebuilt bundle at `server/dist/index.js`, so end users need
nothing extra. If you change anything under `server/src/`, rebuild the bundle
before committing:

```bash
cd server
npm install   # one-time, installs build-time dependencies
npm run build # regenerates server/dist/index.js
```

The build uses esbuild to produce a single self-contained ESM file. Runtime
dependencies are bundled in, which is why they live under `devDependencies` and
`node_modules` is not shipped.
