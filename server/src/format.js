// Renders Sentry's verbose REST payloads as readable Markdown / plain text.
//
// Everything here is a pure function over an already-fetched payload. Stack
// frames are printed exactly as Sentry returned them: no symbolication, no
// ProGuard or dSYM mapping, no reordering.

/** Trims, normalises non-ASCII punctuation, and caps the length of free text. */
export function tidyText(text, maxLength = 4000) {
  const cleaned = (text ?? "")
    .toString()
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "\n...[truncated]" : cleaned;
}

/** Collapses a value into a single-line table cell. */
function cell(value) {
  if (value === undefined || value === null || value === "") return "";
  return tidyText(value, 300).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/** Builds a "key = value" list from a plain object, skipping empty values. */
function keyValueLines(obj) {
  return Object.entries(obj ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k} = ${tidyText(v, 300)}`);
}

/** Looks a tag up in Sentry's [{ key, value }] tag array. */
function tagValue(tags, key) {
  const found = (Array.isArray(tags) ? tags : []).find((t) => t?.key === key);
  return found?.value ?? null;
}

/**
 * Markdown table of the organization's projects. Slug comes first because that
 * is the value search_issues takes.
 */
export function formatProjects(projects, cap = 100, hasMore = false) {
  const list = Array.isArray(projects) ? projects : [];
  if (list.length === 0) return "No projects visible to this token.";

  const shown = list.slice(0, cap);
  const lines = [
    `${list.length} project(s).`,
    "",
    "| Slug | Name | Platform | First event | Last event |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const p of shown) {
    lines.push(
      `| ${cell(p?.slug)} | ${cell(p?.name)} | ${cell(p?.platform)} | ` +
        `${cell(p?.firstEvent)} | ${cell(p?.lastEvent ?? p?.latestDeploys?.dateFinished)} |`
    );
  }
  if (list.length > shown.length) {
    lines.push("");
    lines.push(`Truncated: ${list.length - shown.length} further project(s) not shown.`);
  }
  if (hasMore) {
    lines.push("");
    lines.push("More projects exist than were fetched, so this list is incomplete.");
  }
  return lines.join("\n");
}

/** One readable block per issue, plus the effective filters and a has-more line. */
export function formatIssueList(issues, { returned, hasMore, filters } = {}) {
  const list = Array.isArray(issues) ? issues : [];
  const lines = [];

  const filterLines = keyValueLines(filters);
  lines.push("## Filters applied");
  lines.push("");
  lines.push(filterLines.length > 0 ? filterLines.join("\n") : "(none)");
  lines.push("");
  lines.push(`## Issues (${returned ?? list.length} returned)`);
  lines.push("");

  if (list.length === 0) {
    lines.push("No issues matched.");
  } else {
    for (const issue of list) {
      lines.push(`### ${issue?.shortId ?? issue?.id ?? "(unknown)"} - ${tidyText(issue?.title, 300)}`);
      lines.push("");
      lines.push(`- id: ${issue?.id ?? ""}`);
      lines.push(`- culprit: ${tidyText(issue?.culprit ?? "", 300) || "(none)"}`);
      lines.push(`- level: ${issue?.level ?? ""}`);
      lines.push(`- status: ${issue?.status ?? ""}`);
      lines.push(`- events: ${issue?.count ?? ""}`);
      lines.push(`- users affected: ${issue?.userCount ?? ""}`);
      lines.push(`- first seen: ${issue?.firstSeen ?? ""}`);
      lines.push(`- last seen: ${issue?.lastSeen ?? ""}`);
      lines.push("");
    }
  }

  lines.push(
    hasMore
      ? "More results exist beyond this page. Narrow the query or raise limit (max 50) to see them."
      : "This is the complete result set for these filters."
  );
  return lines.join("\n");
}

// Fields requested from the logs dataset, in request order. Confirmed against
// the live API: user.id and severity_number are accepted but never populated on
// log rows, so they are not requested.
// timestamp is second precision only; timestamp_precise (ns since epoch) supplies the milliseconds.
// id is only used to drop rows repeated across pages, never written to the file.
export const LOG_ID_FIELD = "id";
export const LOG_TIMESTAMP_FIELD = "timestamp";
export const LOG_TIMESTAMP_PRECISE_FIELD = "timestamp_precise";
export const LOG_MESSAGE_FIELD = "message";
export const LOG_SEVERITY_FIELD = "severity";
export const LOG_TRACE_FIELD = "trace";
export const LOG_FIELDS = [
  LOG_ID_FIELD,
  LOG_TIMESTAMP_FIELD,
  LOG_TIMESTAMP_PRECISE_FIELD,
  LOG_MESSAGE_FIELD,
  LOG_SEVERITY_FIELD,
  LOG_TRACE_FIELD,
  "project",
  "environment",
  "release",
];

/** Field table for a single issue, used in tool output and in the saved Markdown. */
export function formatIssueDetail(issue) {
  const release = issue?.lastRelease?.version ?? issue?.firstRelease?.version ?? "";
  const lines = [
    "| Field | Value |",
    "| --- | --- |",
    `| Title | ${cell(issue?.title)} |`,
    `| Short id | ${cell(issue?.shortId)} |`,
    `| Id | ${cell(issue?.id)} |`,
    `| Project | ${cell(issue?.project?.slug)} |`,
    `| Level | ${cell(issue?.level)} |`,
    `| Status | ${cell(issue?.status)} |`,
    `| Culprit | ${cell(issue?.culprit)} |`,
    `| Permalink | ${cell(issue?.permalink)} |`,
    `| Events | ${cell(issue?.count)} |`,
    `| Users affected | ${cell(issue?.userCount)} |`,
    `| First seen | ${cell(issue?.firstSeen)} |`,
    `| Last seen | ${cell(issue?.lastSeen)} |`,
    `| Release | ${cell(release)} |`,
  ];
  return lines.join("\n");
}

/** Metadata and annotations sections for the saved Markdown. */
export function formatIssueExtras(issue) {
  const lines = [];
  lines.push("## Metadata");
  lines.push("");
  const metadata = keyValueLines(issue?.metadata);
  lines.push(metadata.length > 0 ? metadata.join("\n") : "(none)");
  lines.push("");
  lines.push("## Annotations");
  lines.push("");
  const annotations = (Array.isArray(issue?.annotations) ? issue.annotations : []).map((a) =>
    typeof a === "string" ? tidyText(a, 300) : tidyText(a?.displayName ?? JSON.stringify(a), 300)
  );
  lines.push(annotations.length > 0 ? annotations.map((a) => `- ${a}`).join("\n") : "(none)");
  return lines.join("\n");
}

/** Renders one frame exactly as the payload describes it. */
function formatFrame(frame, index) {
  const fn = frame?.function ?? frame?.rawFunction ?? "(anonymous)";
  const where = frame?.module ?? frame?.filename ?? frame?.absPath ?? "(unknown)";
  const line = frame?.lineNo !== undefined && frame?.lineNo !== null ? `:${frame.lineNo}` : "";
  const col = frame?.colNo !== undefined && frame?.colNo !== null ? `:${frame.colNo}` : "";
  const inApp = frame?.inApp ? " [in-app]" : "";
  return `#${index} ${fn} (${where}${line}${col})${inApp}`;
}

/** Pulls the stack frames out of whichever entry shape carries them. */
function collectStacks(entries) {
  const stacks = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type === "exception") {
      for (const value of entry?.data?.values ?? []) {
        stacks.push({
          label: [value?.type, value?.value].filter(Boolean).join(": ") || "Exception",
          module: value?.module ?? null,
          frames: value?.stacktrace?.frames ?? [],
        });
      }
    } else if (entry?.type === "stacktrace") {
      stacks.push({ label: "Stack trace", module: null, frames: entry?.data?.frames ?? [] });
    } else if (entry?.type === "threads") {
      for (const value of entry?.data?.values ?? []) {
        stacks.push({
          label: `Thread ${value?.id ?? ""}${value?.crashed ? " (crashed)" : ""}`.trim(),
          module: null,
          frames: value?.stacktrace?.frames ?? [],
        });
      }
    }
  }
  return stacks;
}

function collectBreadcrumbs(entries) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type === "breadcrumbs") return entry?.data?.values ?? [];
  }
  return [];
}

/**
 * Renders a single event: header, exception chain with frames, breadcrumbs and
 * tags. Any missing section renders as a placeholder rather than throwing.
 */
export function formatEvent(event, { frameCap = 60, breadcrumbCap = 40 } = {}) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const lines = [];

  lines.push("## Event");
  lines.push("");
  lines.push(`- event id: ${event?.id ?? event?.eventID ?? ""}`);
  lines.push(`- timestamp: ${event?.dateCreated ?? event?.dateReceived ?? ""}`);
  lines.push(`- message: ${tidyText(event?.title ?? event?.message ?? "", 300) || "(none)"}`);
  lines.push(`- release: ${tagValue(tags, "release") ?? "(none)"}`);
  lines.push(`- environment: ${tagValue(tags, "environment") ?? "(none)"}`);
  lines.push("");

  const stacks = collectStacks(event?.entries);
  lines.push("## Exception and stack trace");
  lines.push("");
  if (stacks.length === 0) {
    lines.push("(no stack trace in this event)");
  } else {
    lines.push(
      "Frames are printed in payload order, most recent call last, exactly as Sentry returned them (no symbolication or mapping applied)."
    );
    for (const stack of stacks) {
      lines.push("");
      lines.push(`### ${tidyText(stack.label, 500)}`);
      if (stack.module) lines.push(`module: ${tidyText(stack.module, 300)}`);
      lines.push("");
      const frames = Array.isArray(stack.frames) ? stack.frames : [];
      if (frames.length === 0) {
        lines.push("(no frames)");
        continue;
      }
      const shown = frames.slice(0, frameCap);
      lines.push("```");
      shown.forEach((frame, i) => lines.push(formatFrame(frame, i + 1)));
      lines.push("```");
      if (frames.length > shown.length) {
        lines.push(`Truncated: ${frames.length - shown.length} further frame(s) not shown.`);
      }
    }
  }
  lines.push("");

  const breadcrumbs = collectBreadcrumbs(event?.entries);
  lines.push("## Breadcrumbs");
  lines.push("");
  if (breadcrumbs.length === 0) {
    lines.push("(none)");
  } else {
    const shown = breadcrumbs.slice(0, breadcrumbCap);
    for (const crumb of shown) {
      lines.push(
        `- ${crumb?.timestamp ?? ""} [${crumb?.level ?? ""}] ${crumb?.category ?? ""}: ` +
          `${tidyText(crumb?.message ?? crumb?.type ?? "", 300)}`
      );
    }
    if (breadcrumbs.length > shown.length) {
      lines.push(`Truncated: ${breadcrumbs.length - shown.length} further breadcrumb(s) not shown.`);
    }
  }
  lines.push("");

  lines.push("## Tags");
  lines.push("");
  if (tags.length === 0) {
    lines.push("(none)");
  } else {
    for (const tag of tags) {
      lines.push(`${tag?.key ?? ""} = ${tidyText(tag?.value ?? "", 300)}`);
    }
  }
  return lines.join("\n");
}

function percentage(count, total) {
  const t = Number(total);
  const c = Number(count);
  if (!Number.isFinite(t) || !Number.isFinite(c) || t <= 0) return "";
  return ` (${((c / t) * 100).toFixed(1)}%)`;
}

/** All tag keys on an issue with their top values. */
export function formatTagOverview(tags, cap = 10) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return "No tags recorded on this issue.";

  const lines = [`${list.length} tag key(s).`];
  for (const tag of list) {
    lines.push("");
    lines.push(`### ${tag?.key ?? ""}`);
    lines.push("");
    lines.push(`- total values: ${tag?.totalValues ?? ""}`);
    lines.push(`- unique values: ${tag?.uniqueValues ?? (tag?.topValues?.length ?? "")}`);
    const topValues = Array.isArray(tag?.topValues) ? tag.topValues : [];
    if (topValues.length === 0) {
      lines.push("- top values: (none returned)");
      continue;
    }
    const shown = topValues.slice(0, cap);
    for (const v of shown) {
      lines.push(
        `  - ${tidyText(v?.value ?? v?.name ?? "", 300)} - ${v?.count ?? ""}` +
          percentage(v?.count, tag?.totalValues)
      );
    }
    if (topValues.length > shown.length) {
      lines.push(`  - truncated: ${topValues.length - shown.length} further value(s) not shown.`);
    }
  }
  return lines.join("\n");
}

/** One tag key in detail, values sorted by count descending. */
export function formatTagDetail(tagDetail, cap = 25) {
  if (!tagDetail || typeof tagDetail !== "object") return "No detail returned for this tag key.";

  const total = tagDetail.totalValues;
  const values = (Array.isArray(tagDetail.topValues) ? [...tagDetail.topValues] : []).sort(
    (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
  );

  const lines = [
    `## Tag ${tagDetail.key ?? ""}`,
    "",
    `- name: ${tagDetail.name ?? ""}`,
    `- total values: ${total ?? ""}`,
    `- unique values: ${tagDetail.uniqueValues ?? values.length}`,
    "",
  ];

  if (values.length === 0) {
    lines.push("(no values returned)");
    return lines.join("\n");
  }

  const shown = values.slice(0, cap);
  for (const v of shown) {
    lines.push(
      `- ${tidyText(v?.value ?? v?.name ?? "", 300)} - ${v?.count ?? ""}` +
        percentage(v?.count, total) +
        (v?.lastSeen ? `, last seen ${v.lastSeen}` : "")
    );
  }
  if (values.length > shown.length) {
    lines.push("");
    lines.push(`Truncated: ${values.length - shown.length} further value(s) not shown.`);
  }
  return lines.join("\n");
}
