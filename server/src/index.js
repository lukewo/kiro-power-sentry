#!/usr/bin/env node
// Read-only Sentry MCP server (stdio transport).
//
// Exposes read-only tools over the Sentry REST API. It performs GET requests
// only and has no capability to resolve, ignore, assign, comment on, delete, or
// otherwise modify anything in Sentry.
//
// Credentials are read from a single config file at
// ~/.kiro/powers/data/kiro-power-sentry/config.json (baseUrl, organization,
// authToken, defaultProject). It is created as an empty template on first run
// if missing, so no credentials ever live inside this power directory.

// Trust the OS certificate store before any HTTPS request is made. This lets
// the server work behind corporate TLS-inspection proxies. Must be first.
import "./trust-system-ca.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readConfig, SentryClient } from "./sentry-client.js";
import {
  formatEvent,
  formatIssueDetail,
  formatIssueList,
  formatProjects,
  formatTagDetail,
  formatTagOverview,
  LOG_FIELDS,
} from "./format.js";
import { saveIssue } from "./issue-store.js";
import { saveLogs } from "./log-store.js";

const PROJECT_ROW_CAP = 100;
const DEFAULT_ISSUE_LIMIT = 25;
const MAX_ISSUE_LIMIT = 50;
// limit is the total rows across all pages, not a page size; 5000 = 50 pages of 100.
const DEFAULT_LOG_LIMIT = 5000;
const MAX_LOG_LIMIT = 5000;

// Fail fast with a clear message if the credentials are not configured.
let client;
try {
  client = new SentryClient(readConfig());
} catch (err) {
  process.stderr.write(`[sentry] ${err.message}\n`);
  process.exit(1);
}

const server = new McpServer({
  name: "sentry",
  version: "1.2.0",
});

/** These tools return readable text rather than JSON, so the model can read it directly. */
function toolText(text) {
  return { content: [{ type: "text", text }] };
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

server.registerTool(
  "list_projects",
  {
    title: "List Sentry projects",
    description:
      "List the projects in the configured Sentry organization, with their slugs, names and " +
      "platforms. Use the slug to filter search_issues. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      const { data, hasMore } = await client.listProjects();
      // Primes the slug -> numeric id cache so a later search costs no extra call.
      client.cacheProjects(data);
      return toolText(formatProjects(data, PROJECT_ROW_CAP, hasMore));
    } catch (err) {
      return toolError(`list_projects failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "search_issues",
  {
    title: "Search Sentry issues",
    description:
      "Search issues in the Sentry organization using Sentry search syntax (e.g. " +
      "\"is:unresolved release:1.2.3\"). Returns a capped list with event and user counts; " +
      "does not save anything to disk. Read-only.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Sentry search query. Omit for the default is:unresolved; pass an empty string for all issues."
        ),
      project: z
        .string()
        .optional()
        .describe("Project slug or numeric id to filter by. Defaults to defaultProject from config."),
      statsPeriod: z
        .string()
        .optional()
        .describe("Relative time window, e.g. 24h, 7d, 14d (default 14d)"),
      sort: z
        .enum(["freq", "date", "new", "user"])
        .optional()
        .describe("Sort order: freq (events), date (last seen), new (first seen), user (users)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ISSUE_LIMIT)
        .optional()
        .describe(`Maximum issues to return (1-${MAX_ISSUE_LIMIT}, default ${DEFAULT_ISSUE_LIMIT})`),
      environment: z.string().optional().describe("Environment name to filter by, e.g. production"),
    },
  },
  async ({ query, project, statsPeriod, sort, limit, environment }) => {
    try {
      // An explicit empty string means "all issues", so only an omitted query
      // falls back to the default filter.
      const effectiveQuery = query === undefined ? "is:unresolved" : query;
      const effectivePeriod = statsPeriod?.trim() || "14d";
      const cap = Math.min(limit ?? DEFAULT_ISSUE_LIMIT, MAX_ISSUE_LIMIT);
      const projectInput = project?.trim() || client.defaultProject || "";
      const projectId = projectInput ? await client.resolveProjectId(projectInput) : undefined;

      // Search is discovery only - it saves nothing to disk. Use get_issue on a
      // specific issue to persist it.
      const { data, hasMore } = await client.searchIssues({
        query: effectiveQuery,
        project: projectId,
        statsPeriod: effectivePeriod,
        sort,
        limit: cap,
        environment: environment?.trim() || undefined,
      });

      return toolText(
        formatIssueList(data, {
          returned: data.length,
          hasMore,
          filters: {
            query: effectiveQuery === "" ? "(empty - all issues)" : effectiveQuery,
            project: projectInput ? `${projectInput} (id ${projectId})` : "(all projects)",
            statsPeriod: effectivePeriod,
            sort: sort ?? "(Sentry default)",
            limit: cap,
            environment: environment?.trim() || "(all)",
          },
        })
      );
    } catch (err) {
      return toolError(`search_issues failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "search_logs",
  {
    title: "Search Sentry logs",
    description:
      "Search Sentry structured Logs (Explore > Logs), a separate dataset from issues and events. " +
      "Use it to follow what happened for a user, driver, order or trace. Follows result pages to " +
      `pull every matching row up to limit (default and max ${MAX_LOG_LIMIT}), writes them oldest ` +
      "first to a Serilog-style .log file under .sentry/logs/ in the open workspace (git-ignored), " +
      "and returns the saved path and whether the full set was retrieved. Log lines are not " +
      "returned in chat. Read-only.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Sentry search query over log attributes. Omit for no filter. Raw text matches the message " +
            "attribute and IS case sensitive; quote a phrase to match it exactly. Filters that work: " +
            "severity:error, trace:abc123, environment:PROD_BFF, release:1.2.3, and custom log " +
            "attributes such as DriverId:15744."
        ),
      project: z
        .string()
        .optional()
        .describe(
          "Project slug or numeric id. Passed to Sentry verbatim. Defaults to defaultProject from config."
        ),
      statsPeriod: z
        .string()
        .optional()
        .describe("Relative time window, e.g. 1h, 24h, 14d, 90d (default 24h)"),
      severity: z
        .string()
        .optional()
        .describe(
          "Convenience filter folded into the query as severity:<value>, e.g. error, warn, info, debug. " +
            "Composes with query rather than replacing it."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LOG_LIMIT)
        .optional()
        .describe(
          `Total log entries to fetch across all pages (1-${MAX_LOG_LIMIT}, default ` +
            `${DEFAULT_LOG_LIMIT}). Pages of 100 are followed until this many rows are collected ` +
            "or results run out."
        ),
      environment: z.string().optional().describe("Environment name to filter by, e.g. PROD_BFF"),
      sort: z
        .string()
        .optional()
        .describe(
          "Sort order Sentry pages in, e.g. -timestamp for newest first or timestamp for oldest " +
            "first (default -timestamp). The saved file is always written oldest first regardless."
        ),
    },
  },
  async ({ query, project, statsPeriod, severity, limit, environment, sort }) => {
    try {
      const terms = [];
      const userQuery = query?.trim();
      if (userQuery) terms.push(userQuery);
      const severityValue = severity?.trim();
      if (severityValue) terms.push(`severity:${severityValue}`);
      const effectiveQuery = terms.join(" ");

      const effectivePeriod = statsPeriod?.trim() || "24h";
      const effectiveSort = sort?.trim() || "-timestamp";
      const cap = Math.min(limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
      const projectInput = project?.trim() || client.defaultProject || undefined;

      const environmentValue = environment?.trim() || undefined;

      const { data, hasMore, pages } = await client.searchLogs({
        query: effectiveQuery || undefined,
        project: projectInput,
        statsPeriod: effectivePeriod,
        environment: environmentValue,
        fields: LOG_FIELDS,
        limit: cap,
        sort: effectiveSort,
      });

      // Dropping rows repeated by live paging can exhaust the page cap before the row limit.
      const hitRowLimit = data.length >= cap;
      const ceiling = hitRowLimit ? `the ${cap}-row limit` : `the ${pages}-page ceiling`;

      const saved = saveLogs({
        rows: data,
        hasMore,
        ceiling,
        pages,
        limit: cap,
        sort: effectiveSort,
        organization: client.organization,
        project: projectInput,
        query: effectiveQuery,
        severity: severityValue,
        environment: environmentValue,
        statsPeriod: effectivePeriod,
      });

      const filters = {
        query: effectiveQuery || "(none - all log entries)",
        project: projectInput ?? "(all projects)",
        statsPeriod: effectivePeriod,
        severity: severityValue || "(all)",
        sort: effectiveSort,
        limit: cap,
        environment: environmentValue ?? "(all)",
      };

      // The log lines live in the file only, so the chat response stays small at 5000 rows.
      const lines = [
        `Saved ${saved.rowCount} log entries to ${saved.logPath}`,
        "",
        hasMore
          ? `- status: capped - stopped at ${ceiling}; more matching rows exist beyond it ` +
            `(narrow the query or window` +
            (hitRowLimit && cap < MAX_LOG_LIMIT ? `, or raise limit up to ${MAX_LOG_LIMIT})` : ")")
          : "- status: complete - every matching row was retrieved",
        `- rows: ${saved.rowCount}`,
        `- pages fetched: ${pages}`,
        `- savedInWorkspace: ${saved.savedInWorkspace}`,
        `- workspace: ${saved.workspace ?? "(not detected)"}`,
        `- locationAssumed: ${saved.locationAssumed}`,
        `- locationReason: ${saved.locationReason}`,
        "",
        "## Filters applied",
        "",
        ...Object.entries(filters).map(([key, value]) => `${key} = ${value}`),
      ];
      return toolText(lines.join("\n"));
    } catch (err) {
      return toolError(`search_logs failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_issue",
  {
    title: "Get Sentry issue",
    description:
      "Fetch one issue by numeric id or short id (e.g. MYAPP-4F2) together with its latest event, " +
      "and save it to .sentry/<ID>/ in the open workspace as Markdown with the stack trace, " +
      "breadcrumbs and tags. Returns the summary plus where it was saved. Read-only.",
    inputSchema: {
      issueId: z
        .string()
        .min(1)
        .describe("The numeric Sentry issue id, or a short id such as MYAPP-4F2"),
    },
  },
  async ({ issueId }) => {
    try {
      const id = await client.resolveIssueId(issueId.trim());
      const issue = await client.getIssue(id);

      // The latest event carries the stack trace. Failing to fetch it is
      // reported in the saved file rather than failing the whole call.
      let latestEvent = null;
      let eventError = null;
      try {
        latestEvent = await client.getEvent(id, "latest");
      } catch (err) {
        eventError = err.message;
      }

      const saved = saveIssue(issue, latestEvent, eventError);

      const lines = [
        formatIssueDetail(issue),
        "",
        "## Saved",
        "",
        `- markdown: ${saved.markdownPath}`,
        `- folder: ${saved.issueDir}`,
        `- savedInWorkspace: ${saved.savedInWorkspace}`,
        `- workspace: ${saved.workspace ?? "(not detected)"}`,
        `- locationAssumed: ${saved.locationAssumed}`,
        `- locationReason: ${saved.locationReason}`,
      ];
      if (eventError) {
        lines.push("");
        lines.push(`Latest event could not be fetched: ${eventError}`);
      }
      return toolText(lines.join("\n"));
    } catch (err) {
      return toolError(`get_issue failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_event",
  {
    title: "Get Sentry event",
    description:
      "Fetch one event from an issue and render its exception chain, stack frames, breadcrumbs and " +
      "tags exactly as Sentry returned them (no symbolication or mapping). Saves nothing to disk. " +
      "Read-only.",
    inputSchema: {
      issueId: z
        .string()
        .min(1)
        .describe("The numeric Sentry issue id, or a short id such as MYAPP-4F2"),
      eventId: z
        .string()
        .optional()
        .describe("latest, oldest, recommended, or a specific event id (default latest)"),
      environment: z.string().optional().describe("Environment name to filter by, e.g. production"),
    },
  },
  async ({ issueId, eventId, environment }) => {
    try {
      const id = await client.resolveIssueId(issueId.trim());
      const event = await client.getEvent(
        id,
        eventId?.trim() || "latest",
        environment?.trim() || undefined
      );
      return toolText(formatEvent(event, {}));
    } catch (err) {
      return toolError(`get_event failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_issue_tags",
  {
    title: "Get Sentry issue tags",
    description:
      "Fetch the tag breakdown for an issue: every tag key with its top values and counts, or a " +
      "single key in detail when key is given. Useful for spotting the device, OS version or " +
      "release a crash concentrates on. Read-only.",
    inputSchema: {
      issueId: z
        .string()
        .min(1)
        .describe("The numeric Sentry issue id, or a short id such as MYAPP-4F2"),
      key: z
        .string()
        .optional()
        .describe("A single tag key to detail, e.g. release, os.name, device.family"),
      environment: z.string().optional().describe("Environment name to filter by, e.g. production"),
    },
  },
  async ({ issueId, key, environment }) => {
    try {
      const id = await client.resolveIssueId(issueId.trim());
      const env = environment?.trim() || undefined;
      const tagKey = key?.trim();
      if (tagKey) {
        return toolText(formatTagDetail(await client.getIssueTagKey(id, tagKey, env)));
      }
      return toolText(formatTagOverview(await client.getIssueTags(id, env)));
    } catch (err) {
      return toolError(`get_issue_tags failed: ${err.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[sentry] read-only MCP server started\n");
