// Persists fetched Sentry issues so they are visible in the project you are
// working in.
//
// Layout, inside the detected workspace folder:
//   <workspace>/.sentry/
//     .gitignore              - ignores everything here, so issues are never committed
//     <ISSUE-ID>/
//       <ISSUE-ID>.md         - issue details plus the latest event's stack trace
//
// If the workspace cannot be determined, the same structure is written under the
// power's own data directory instead, so a fetch never silently loses data.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./sentry-client.js";
import { formatEvent, formatIssueDetail, formatIssueExtras, tidyText } from "./format.js";
import { detectWorkspace } from "./workspace.js";

/**
 * Resolves the root the issue folders live under, preferring the open workspace
 * and falling back to the power's data directory.
 */
function resolveIssueRoot() {
  const ws = detectWorkspace();
  if (ws.path) {
    return {
      root: join(ws.path, ".sentry"),
      inWorkspace: true,
      workspace: ws.path,
      assumed: ws.assumed,
      reason: ws.reason,
    };
  }
  return {
    root: CONFIG_DIR,
    inWorkspace: false,
    workspace: null,
    assumed: false,
    reason: `${ws.reason}; saved to the power data folder instead`,
  };
}

/**
 * Ensures a .gitignore inside the .sentry folder so issue data is never
 * committed. Written once; an existing file is left untouched.
 */
function ensureGitignore(root) {
  const path = join(root, ".gitignore");
  if (existsSync(path)) return;
  const body =
    "# Sentry issue data fetched by the sentry Kiro power.\n" +
    "# Local working context - not intended to be committed.\n" +
    "*\n" +
    "!.gitignore\n";
  writeFileSync(path, body, "utf8");
}

/** Makes a string safe to use as a file or folder name on Windows and POSIX. */
function safeName(name, fallback) {
  const cleaned = (name ?? "").toString().trim().replace(/[^\w.\- ]/g, "_").trim();
  return cleaned || fallback;
}

/** Renders the issue and its latest event to Markdown. */
function renderIssueMarkdown(issue, latestEvent, eventError) {
  const lines = [];
  lines.push(`# ${issue?.shortId ?? issue?.id ?? "(unknown)"} - ${tidyText(issue?.title, 300)}`);
  lines.push("");
  lines.push(formatIssueDetail(issue));
  lines.push("");
  lines.push(formatIssueExtras(issue));
  lines.push("");
  lines.push("# Latest event");
  lines.push("");
  if (latestEvent) {
    lines.push(formatEvent(latestEvent, {}));
  } else {
    lines.push(`(latest event not available${eventError ? `: ${eventError}` : ""})`);
  }
  lines.push("");
  lines.push(`_Saved ${new Date().toISOString()} by the sentry power._`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Writes a fetched issue to disk: creates <root>/<ID>/ and writes <ID>.md with
 * the issue fields and the latest event's exception, frames, breadcrumbs and
 * tags. A re-fetch overwrites the file, so the folder always holds the latest.
 *
 * @param {object} issue the raw Sentry issue (from client.getIssue)
 * @param {object|null} latestEvent the raw latest event, or null if it could not be fetched
 * @param {string|null} [eventError] why the event is missing, if it is
 */
export function saveIssue(issue, latestEvent, eventError = null) {
  const target = resolveIssueRoot();
  const folder = safeName(issue?.shortId ?? issue?.id, "unknown-issue");

  const issueDir = join(target.root, folder);
  mkdirSync(issueDir, { recursive: true });

  // Only the workspace .sentry folder needs ignoring; the data dir is outside any repo.
  if (target.inWorkspace) ensureGitignore(target.root);

  const markdownPath = join(issueDir, `${folder}.md`);
  writeFileSync(markdownPath, renderIssueMarkdown(issue, latestEvent, eventError), "utf8");

  return {
    issueDir,
    markdownPath,
    savedInWorkspace: target.inWorkspace,
    workspace: target.workspace,
    locationAssumed: target.assumed,
    locationReason: target.reason,
  };
}
