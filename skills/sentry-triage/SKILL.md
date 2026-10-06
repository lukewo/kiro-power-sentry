---
name: "sentry-triage"
description: "Triage a Sentry crash report down to a specific stack trace. Use when someone reports a crash, a spike in errors, or a vague production problem and you need the actual exception, frames and affected devices."
license: "MIT"
metadata:
  author: "Luke Worthington"
  version: "1.0.0"
---

# Sentry triage

Turn a vague crash report into a concrete exception and stack trace using the
read-only `sentry` power. The five tools form one linear workflow: find the
project, search for the issue, open the issue, open a specific event, then slice
the issue by tag to see what it concentrates on.

Everything here is read-only. None of these tools can resolve, ignore, assign,
comment on or delete anything in Sentry.

## Prerequisites

- The `sentry` power is installed and its server is connected.
- `~/.kiro/powers/data/kiro-power-sentry/config.json` has `organization` and
  `authToken` filled in.
- The auth token carries the read scopes `event:read`, `project:read` and
  `org:read`. A 403 naming a scope means the token is missing it.

## Workflow

### 1. Find the project slug - `list_projects`

Start here when you do not already know the slug. It takes no arguments.

```
list_projects
```

Returns a table of slug, name, platform and event dates. The slug is what
`search_issues` takes. If `defaultProject` is set in the config you can skip
this step.

### 2. Find the issue - `search_issues`

```
search_issues { "project": "my-android-app", "query": "is:unresolved", "statsPeriod": "14d", "sort": "freq", "limit": 25 }
```

- `query` omitted defaults to `is:unresolved`. Pass `""` explicitly to search
  all issues regardless of status.
- `project` takes a slug or a numeric id; omitted, it falls back to
  `defaultProject` from the config, and with neither set it searches the whole
  organization.
- `statsPeriod` defaults to `14d`. Use `24h` for "it started today".
- `sort` is one of `freq` (most events), `date` (most recently seen), `new`
  (newest first), `user` (most users affected).
- `limit` is capped at 50, default 25.
- The output echoes the filters that actually ran, then states whether more
  results exist beyond the page. It saves nothing to disk.

Note the `shortId` (e.g. `MY-ANDROID-APP-4F2`) or the numeric `id` of the issue
you want.

### 3. Open the issue - `get_issue`

```
get_issue { "issueId": "MY-ANDROID-APP-4F2" }
```

Accepts a numeric id or a short id. It fetches the issue plus its latest event
and writes `<workspace>/.sentry/<ID>/<ID>.md`, containing the issue fields, the
metadata and annotations, and the latest event's exception, stack frames,
breadcrumbs and tags. The response includes the saved path, so you can open the
file and read the trace in full.

If `locationAssumed` is `true`, several Kiro windows were open and the power
picked one; check the reported `workspace` is the project you meant. If
`savedInWorkspace` is `false`, the workspace could not be detected and the file
went to the power's data folder instead.

### 4. Open a specific event - `get_event`

```
get_event { "issueId": "MY-ANDROID-APP-4F2", "eventId": "latest" }
```

`eventId` accepts `latest` (default), `oldest`, `recommended`, or a real event
id. Add `environment` to pin it to one environment. Useful when the latest event
is unhelpful and the oldest one shows the original regression, or to compare a
production event against staging. Saves nothing to disk.

### 5. See what the crash concentrates on - `get_issue_tags`

```
get_issue_tags { "issueId": "MY-ANDROID-APP-4F2" }
get_issue_tags { "issueId": "MY-ANDROID-APP-4F2", "key": "os.name" }
```

Without `key`: every tag key on the issue with its top values and counts.
With `key`: that one key in detail, values sorted by count with percentages and
last-seen dates. This is how you tell "all Android 9" or "only release 3.4.1"
from "everywhere".

## Sentry search recipes

Pass any of these as `query` to `search_issues`. Terms combine with spaces.

| Query | Finds |
|---|---|
| `is:unresolved` | Open issues. The default when `query` is omitted. |
| `is:resolved` | Issues someone has marked resolved. |
| `is:ignored` | Muted issues. |
| `release:3.4.1` | Issues seen in that release. |
| `firstRelease:3.4.1` | Issues that first appeared in that release - regressions introduced by it. |
| `environment:production` | One environment. The `environment` argument does the same. |
| `timesSeen:>100` | Issues with more than 100 events. |
| `lastSeen:-24h` | Issues seen in the last 24 hours. |
| `firstSeen:-7d` | Issues that first appeared in the last week. |
| `assigned:you@example.com` | Issues assigned to a person. |
| `unassigned:true` | Issues nobody owns. |
| `error.handled:false` | Unhandled crashes. |
| `NullReferenceException` | Free-text match against the title and culprit. |
| `device.family:"Samsung SM-G973F"` | Any tag, by key. Quote values containing spaces. |
| `os.name:Android os.version:9` | Several tags at once. |
| `app.version:3.4.1` | A custom tag your app sets. |
| `!release:3.4.1` | Negation: everything except that release. |

Useful combinations:

- New in the latest build: `is:unresolved firstRelease:3.4.1` with `sort: "new"`
- Worst thing happening right now: `is:unresolved lastSeen:-24h` with
  `sort: "freq"` and `statsPeriod: "24h"`
- Crashes only, not handled errors: `is:unresolved error.handled:false`

## Reading the rendered frames

- Frames print in payload order, numbered, under a heading saying most recent
  call last. The crashing frame is the last one listed.
- `[in-app]` marks a frame Sentry considers your own code rather than a
  framework or runtime frame. Start reading there.
- Each line reads `#n function (module-or-file:line:col)`.
- Frames are shown **exactly as Sentry returned them**. There is no
  symbolication, no ProGuard or dSYM mapping, and no frame resolution. If the
  names look obfuscated or a line number is missing, that is what the payload
  contained - the mapping has to be uploaded to Sentry itself.
- An event with no stack trace renders `(no stack trace in this event)` rather
  than failing. Try `get_event` with `oldest`, or another event id.
- Long traces are capped, and the output says how many frames were dropped.

## What gets written to disk

- `get_issue` writes `<workspace>/.sentry/<ID>/<ID>.md` and creates a
  `.gitignore` inside `.sentry/` on first use, so the cache is never committed.
  Re-fetching overwrites the file with the latest data.
- `search_issues`, `get_event` and `get_issue_tags` write nothing.

## Troubleshooting

- **401** - the auth token is invalid, expired or revoked. Re-check `authToken`
  in the config file and reconnect the server.
- **403** - the token is missing a scope; the message names which one. Add it at
  <https://docs.sentry.io/api/permissions/> and reconnect.
- **404** - the organization slug, project slug, issue id or event id does not
  exist or is not visible to that token. Run `list_projects` to confirm the
  slugs you can actually see.
- **429** - rate limited. The message carries `Retry-After` when Sentry sends
  it; wait that long and retry.
- **No project with slug "..."** - the error lists the slugs available to the
  token. Pick one of those.
- **Nothing matched** - widen `statsPeriod`, drop the `project` filter, or pass
  `query: ""` to include resolved and ignored issues.
