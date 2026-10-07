// Persists search_logs results as Serilog-style .log files so a whole day of
// logs can be opened, grepped and diffed like a device log.
//
// Layout, inside the detected workspace folder:
//   <workspace>/.sentry/
//     .gitignore                         - shared with issue-store.js, ignores everything here
//     logs/
//       <project>_<query>_<time>.log     - one file per search, oldest entry first
//
// If the workspace cannot be determined, the same logs/ folder is written under
// the power's own data directory instead, exactly as issues are.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LOG_MESSAGE_FIELD,
  LOG_SEVERITY_FIELD,
  LOG_TIMESTAMP_FIELD,
  LOG_TIMESTAMP_PRECISE_FIELD,
} from "./format.js";
import { ensureGitignore, resolveSentryRoot } from "./issue-store.js";

const SEVERITY_CODES = {
  trace: "VRB",
  verbose: "VRB",
  debug: "DBG",
  info: "INF",
  information: "INF",
  warn: "WRN",
  warning: "WRN",
  error: "ERR",
  fatal: "FTL",
  critical: "FTL",
};

const UNKNOWN_TIME = "????-??-?? ??:??:??.???";
const COMPONENT_MAX = 60;
const HEADER_DISTINCT_CAP = 10;

/** Maps a Sentry severity to the three-letter Serilog level; anything unknown is INF. */
function serilogLevel(severity) {
  const key = (severity ?? "").toString().trim().toLowerCase();
  return SEVERITY_CODES[key] ?? "INF";
}

/** Epoch milliseconds for a row, from timestamp_precise (ns) when present, else timestamp. */
function rowEpochMs(row) {
  const precise = Number(row?.[LOG_TIMESTAMP_PRECISE_FIELD]);
  if (Number.isFinite(precise) && precise > 0) return Math.round(precise / 1e6);
  const parsed = Date.parse(row?.[LOG_TIMESTAMP_FIELD] ?? "");
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** UTC "yyyy-MM-dd HH:mm:ss.fff"; toISOString always zero-pads the milliseconds. */
function serilogTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return UNKNOWN_TIME;
  return date.toISOString().replace("T", " ").slice(0, 23);
}

function oneLine(message) {
  return (message ?? "").toString().replace(/\r\n|\r|\n/g, " ");
}

function logLine(row) {
  const time = serilogTime(rowEpochMs(row));
  const level = serilogLevel(row?.[LOG_SEVERITY_FIELD]);
  return `[${time} ${level}] ${oneLine(row?.[LOG_MESSAGE_FIELD])}`;
}

/** Oldest first whatever the request sort; rows without a usable time go last. */
function chronological(rows, sort) {
  const list = Array.isArray(rows) ? [...rows] : [];
  // Reversing a descending fetch first keeps same-millisecond rows in their true order under the stable sort.
  if ((sort ?? "").toString().trim().startsWith("-")) list.reverse();
  return list
    .map((row) => ({ row, ms: rowEpochMs(row) }))
    .sort((a, b) => {
      const aBad = !Number.isFinite(a.ms);
      const bBad = !Number.isFinite(b.ms);
      if (aBad || bBad) return aBad === bBad ? 0 : aBad ? 1 : -1;
      return a.ms - b.ms;
    })
    .map(({ row }) => row);
}

function distinct(rows, field, cap = HEADER_DISTINCT_CAP) {
  const values = [];
  for (const row of rows) {
    const value = (row?.[field] ?? "").toString().trim();
    if (value && !values.includes(value)) values.push(value);
  }
  if (values.length === 0) return "(none)";
  const shown = values.slice(0, cap).join(", ");
  return values.length > cap ? `${shown} +${values.length - cap} more` : shown;
}

/** Absolute UTC window for a relative statsPeriod such as 24h, or null if it is not that shape. */
function resolveWindow(statsPeriod, now) {
  const match = /^(\d+)([smhdw])$/.exec((statsPeriod ?? "").toString().trim());
  if (!match) return null;
  const unitMs = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[match[2]];
  const start = new Date(now.getTime() - Number(match[1]) * unitMs);
  return { start: start.toISOString(), end: now.toISOString() };
}

/** The "# " header block. Built from the request and the rows only, never from config secrets. */
function renderHeader(opts) {
  const { organization, project, query, severity, environment, statsPeriod } = opts;
  const { sort, limit, pages, rows, hasMore, ceiling, now } = opts;
  const window = resolveWindow(statsPeriod, now);
  const lines = [
    "Sentry logs exported by the sentry Kiro power (read-only)",
    `organization: ${organization}`,
    `project: ${project || "(all projects)"}`,
    `query: ${query || "(none - all log entries)"}`,
    `severity: ${severity || "(all)"}`,
    `environment: ${environment || "(all)"}`,
    `statsPeriod: ${statsPeriod}`,
    ...(window ? [`window (UTC): ${window.start} to ${window.end}`] : []),
    `sort (request): ${sort}`,
    "order (file): oldest first",
    `limit (requested total): ${limit}`,
    `pages fetched: ${pages}`,
    `rows: ${rows.length}`,
    hasMore
      ? `status: capped - stopped at ${ceiling} and more matching rows exist beyond it; ` +
        "narrow the query or window to get the rest"
      : "status: complete - every matching row is in this file",
    `projects seen: ${distinct(rows, "project")}`,
    `environments seen: ${distinct(rows, "environment")}`,
    `releases seen: ${distinct(rows, "release")}`,
    `generated (UTC): ${now.toISOString()}`,
    "line format: [yyyy-MM-dd HH:mm:ss.fff LVL] message, times in UTC, LVL one of VRB DBG INF WRN ERR FTL",
  ];
  return lines.map((line) => `# ${oneLine(line)}`).join("\n") + "\n\n";
}

/** Reduces text to a bounded [A-Za-z0-9._-] filename component. */
function sanitiseComponent(text, fallback) {
  const cleaned = (text ?? "")
    .toString()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, COMPONENT_MAX)
    .replace(/[-._]+$/g, "");
  return cleaned || fallback;
}

/** 2026-10-07T07:38:12.345Z -> 2026-10-07T0738Z */
function fileStamp(date) {
  return date.toISOString().slice(0, 16).replace(":", "") + "Z";
}

/** Writes without ever overwriting: base.log, then base-2.log, base-3.log, ... */
function writeUnique(dir, base, body) {
  for (let n = 1; ; n += 1) {
    const path = join(dir, n === 1 ? `${base}.log` : `${base}-${n}.log`);
    try {
      writeFileSync(path, body, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
}

/**
 * Writes a search_logs result to <root>/logs/ as a Serilog-style .log file:
 * a "# " header block recording the filters and completeness, then one
 * [yyyy-MM-dd HH:mm:ss.fff LVL] message line per row, oldest first.
 */
export function saveLogs({
  rows,
  hasMore,
  ceiling,
  pages,
  limit,
  sort,
  organization,
  project,
  query,
  severity,
  environment,
  statsPeriod,
}) {
  const list = Array.isArray(rows) ? rows : [];
  const now = new Date();
  const target = resolveSentryRoot();
  const logsDir = join(target.root, "logs");
  mkdirSync(logsDir, { recursive: true });

  // Only the workspace .sentry folder needs ignoring; the data dir is outside any repo.
  if (target.inWorkspace) ensureGitignore(target.root);

  const header = renderHeader({
    organization,
    project,
    query,
    severity,
    environment,
    statsPeriod,
    sort,
    limit,
    pages,
    rows: list,
    hasMore,
    ceiling,
    now,
  });
  const entries =
    list.length > 0
      ? chronological(list, sort).map(logLine).join("\n") + "\n"
      : "# No log entries matched.\n";

  const base =
    `${sanitiseComponent(project, "all-projects")}_` +
    `${sanitiseComponent(query, "all")}_${fileStamp(now)}`;
  const logPath = writeUnique(logsDir, base, header + entries);

  return {
    logPath,
    logsDir,
    rowCount: list.length,
    savedInWorkspace: target.inWorkspace,
    workspace: target.workspace,
    locationAssumed: target.assumed,
    locationReason: target.reason,
  };
}
