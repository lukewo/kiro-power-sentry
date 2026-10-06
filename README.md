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
| `get_issue` | Fetch one issue by numeric id or short id (e.g. `MYAPP-4F2`) plus its latest event, and save it to `.sentry/<ID>/` in your workspace (see below). Returns the summary plus where it was saved. |
| `get_event` | Fetch one event (`latest`, `oldest`, `recommended`, or a specific id) and render the exception chain, stack frames, breadcrumbs and tags. Saves nothing. |
| `get_issue_tags` | Tag breakdown for an issue: every key with its top values and counts, or a single key in detail. |

## Fetched issues are saved into your workspace

Whenever an issue is fetched with `get_issue`, the power writes it into a
`.sentry` folder in the workspace you have open, so it shows up in your file tree
(`search_issues`, `get_event` and `get_issue_tags` are read-through only and save
nothing):

```
<workspace>/.sentry/
  .gitignore              # ignores everything here, so issues are never committed
  <ISSUE-ID>/
    <ISSUE-ID>.md         # issue details plus the latest event, as Markdown
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
The five tools become available.

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
   connect and list `list_projects`, `search_issues`, `get_issue`, `get_event`
   and `get_issue_tags`.
4. Ask Kiro to list your Sentry projects. You should get a table of slugs.
5. Ask Kiro to search a project for unresolved issues, e.g. "search Sentry for
   unresolved issues in my-android-app". Confirm the issues listed are the ones
   you expect, and that the project filter took effect.
6. Ask Kiro to fetch a known issue by its short id, e.g. "get Sentry issue
   MYAPP-4F2". Confirm the response names a saved Markdown path, and open that
   file to check the stack trace is present and readable.
7. Ask Kiro for that issue's tags, e.g. "show the os.name tag for MYAPP-4F2".

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
- Fetched issues are saved under `.sentry/` in your workspace (git-ignored).
  Delete that folder any time; it is just local cache.

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
