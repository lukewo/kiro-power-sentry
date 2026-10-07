---
name: "sentry-triage"
description: "Triage a Sentry crash report down to a specific stack trace, or follow a user's activity through Sentry structured logs. Use when someone reports a crash, a spike in errors, or a vague production problem and you need the actual exception, frames, affected devices or the log trail."
license: "MIT"
metadata:
  author: "Luke Worthington"
  version: "1.2.0"
---

# Sentry triage

Turn a vague crash report into a concrete exception and stack trace using the
read-only `sentry` power. The six tools cover two entry points:

- **Something broke** - find the project, search issues, open the issue, open a
  specific event, then slice the issue by tag to see what it concentrates on.
- **What was this user doing** - pull the structured logs for that user,
  driver, order or trace into a saved `.log` file and read it like a device log.

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

### 6. Follow one user's trail - `search_logs`

Logs are a separate dataset (Sentry's **Explore > Logs**), so this is a sibling
entry point rather than a later step. Reach for it when the report is "what
happened for this driver / user / order" rather than "what crashed". There are no
stack traces here; the hop back to a crash is a `trace:<id>` search.

```
search_logs { "project": "my-android-app", "statsPeriod": "24h" }
search_logs { "query": "offline", "severity": "warn", "project": "my-android-app", "statsPeriod": "24h" }
```

- `query` matches the `message` attribute as raw text, **case sensitive**; quote a
  phrase to match it whole. Attribute filters such as `severity:error`,
  `trace:abc123`, `environment:PROD_BFF` and custom attributes all work.
- `severity` is a convenience folded into the query as `severity:<value>`, so it
  narrows your query rather than replacing it.
- `project` takes a slug directly, no lookup needed, and falls back to
  `defaultProject`.
- `statsPeriod` defaults to `24h`.
- `limit` is the **total** rows, default and max 5000. The power follows pages
  of 100 itself, so a whole day for one driver is a single call - do not page
  manually or lower `limit` to save space.
- Every call writes the full result to a new file, e.g.
  `.sentry/logs/pingo-dotnet-xamarin_DriverId-15744_2026-10-07T0738Z.log`,
  oldest first, one `[yyyy-MM-dd HH:mm:ss.fff LVL] message` line per entry in
  UTC (the same shape as the app's device logs). A `# ` header records the
  filters, row count and status.
- The response gives the saved path, the row count, `complete` or `capped`, and
  where it was saved (`savedInWorkspace`, `workspace`, `locationAssumed`,
  `locationReason`). The log lines are **not** in chat: open or grep the file.
- `capped` means more rows matched than were saved: either `limit` rows or the
  50-page ceiling was reached first (the status names which), keeping the first
  rows in `sort` order (the newest, by default). Narrow the window or add
  `severity` and search again.

**Worked example - one driver.** Identity in logs comes from whatever attribute
the app sets, not from `user.id` (that field exists on the events API but stays
empty on log rows). On a Pingo-style app the driver arrives as `DriverId`:

```
search_logs { "query": "DriverId:15744", "project": "pingo-dotnet-xamarin", "statsPeriod": "24h" }
```

That one call pulls the driver's whole day and saves it as
`.sentry/logs/pingo-dotnet-xamarin_DriverId-15744_<yyyy-MM-ddTHHmmZ>.log`.
Open that file and read it top to bottom; it runs chronologically like a device
log, so you can line it up against a device log pulled for the same session
(remember the saved file is UTC). Grep it for `ERR` or `WRN` to find the
trouble spots. `trace` is not written on the lines, so to pivot to a crash use
`search_issues` for the same driver or window.

Zero rows? Widen before doubting the query:

```
search_logs { "query": "DriverId:15744", "project": "pingo-dotnet-xamarin", "statsPeriod": "14d" }
```

Still nothing across a wide window usually means that user genuinely produced no
logs in retention, or the attribute name differs - try `has:DriverId` on a short
window to see the attribute populated, and confirm the spelling from a real row.
To save just the failures, add `severity`. When an issue or event gives you a
trace id, pull every log row in that trace:

```
search_logs { "query": "DriverId:15744", "severity": "error", "project": "pingo-dotnet-xamarin", "statsPeriod": "14d" }
search_logs { "query": "trace:4f1c...", "project": "pingo-dotnet-xamarin", "statsPeriod": "14d" }
```

The same driver may also have issues of their own, which is the issues-side
query: `search_issues { "query": "user.id:15744" }`.

## Log search recipes

Pass any of these as `query` to `search_logs`.

| Query | Finds |
|---|---|
| `severity:error` | Error-level log rows. Also `warn`, `info`, `debug`. |
| `"API call attempted while offline"` | An exact message phrase, case sensitive. |
| `offline` | Rows whose message contains that text, case sensitive. |
| `trace:67e04bb66c9144ecaf1d47ac5da63697` | Everything logged in one trace, across services. |
| `environment:PROD_BFF` | One environment. The `environment` argument does the same. |
| `release:1.2.3` | Rows from one release. |
| `DriverId:15744` | A custom attribute your app logs. |
| `has:DriverId` | Rows that carry that attribute at all. |
| `severity:error DriverId:15744` | Several terms, ANDed with spaces. |

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
- `search_logs` writes a new `<workspace>/.sentry/logs/<project>_<query>_<time>.log`
  on every call (a same-minute repeat gets `-2`, `-3`, never an overwrite), under
  the same `.gitignore`.
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
