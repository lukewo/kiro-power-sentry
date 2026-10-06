// Minimal read-only Sentry REST API client.
//
// This module ONLY performs HTTP GET requests. There is exactly one place that
// calls fetch() - SentryClient.get - and it hardcodes method "GET". No method
// here can create, resolve, ignore, assign, comment on, or delete anything in
// Sentry. Keeping the surface GET-only is the read-only guarantee for the whole
// Power, enforced by construction rather than by convention.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the credentials file lives.
//
// This is the single, fixed location the power reads and writes - the power's
// data directory under the user's Kiro home, derived from the home directory at
// runtime. There are no alternative paths and no fallbacks, so there is exactly
// one file to fill in and no ambiguity about which one is in use.
//
// It sits outside the power directory on purpose: the installed power folder is
// deleted and recopied on every update, which would destroy the credentials,
// and the source folder is what gets published, which would leak them.
export const CONFIG_DIR = join(
  homedir(),
  ".kiro",
  "powers",
  "data",
  "kiro-power-sentry"
);
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_BASE_URL = "https://sentry.io";

const CONFIG_TEMPLATE = {
  baseUrl: DEFAULT_BASE_URL,
  organization: "",
  authToken: "",
  defaultProject: "",
};

// Sample values used in the README. Treated as empty so pasting the sample
// verbatim fails the missing-field check instead of producing a confusing 404.
const PLACEHOLDER_VALUES = new Set([
  "your-org-slug",
  "your-auth-token",
  "optional-project-slug",
]);

const PERMISSIONS_DOC = "https://docs.sentry.io/api/permissions/";

/** Reads Sentry's rel="next" Link header, which is how it signals further pages. */
function parseNextLink(headers) {
  const link = headers?.get?.("link") ?? "";
  const next = link.split(",").find((part) => part.includes('rel="next"')) ?? "";
  const hasMore = /results="true"/.test(next);
  const cursor = /cursor="([^"]+)"/.exec(next);
  return { hasMore, nextCursor: hasMore && cursor ? cursor[1] : undefined };
}

// Bounds the project cursor walk so a pathological org cannot spin forever.
const PROJECT_PAGE_CAP = 10;

/**
 * Writes the empty config template if no config file exists yet, so the user
 * has a file to fill in rather than having to create one from scratch.
 *
 * @returns {boolean} true if a new template was created
 */
export function ensureConfigFile() {
  if (existsSync(CONFIG_PATH)) return false;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", "utf8");
  return true;
}

/** Reads and parses the per-user config file, tolerating an absent file. */
function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(`Could not read config file ${CONFIG_PATH}: ${err.message}`);
  }
  if (!raw.trim()) return {};
  try {
    // Strip a UTF-8 BOM: common when the file is edited with a Windows editor,
    // and JSON.parse rejects it.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(
      `Config file ${CONFIG_PATH} is not valid JSON. Expected keys: baseUrl, organization, authToken, defaultProject.`
    );
  }
}

/**
 * Resolves and validates the Sentry connection configuration.
 *
 * The config file at CONFIG_PATH is the only source. If it does not exist, an
 * empty template is created there and a descriptive error thrown naming the
 * file, so there is exactly one place for the user to fill in.
 *
 * @returns {{ baseUrl: string, organization: string, authToken: string, defaultProject: string }}
 */
export function readConfig() {
  const created = ensureConfigFile();
  const file = readConfigFile();

  // Ignore unsubstituted "${VAR}" placeholders and the README sample values, in
  // case a value was pasted from a template rather than filled with a real one.
  const clean = (value) => {
    const str = (value ?? "").toString().trim();
    if (str.startsWith("${")) return "";
    return PLACEHOLDER_VALUES.has(str) ? "" : str;
  };

  const rawBaseUrl = clean(file.baseUrl) || DEFAULT_BASE_URL;
  const organization = clean(file.organization);
  const authToken = clean(file.authToken);
  const defaultProject = clean(file.defaultProject);

  const missing = [];
  if (!organization) missing.push("organization");
  if (!authToken) missing.push("authToken");

  if (missing.length > 0) {
    const lead = created
      ? `Created a new config file at ${CONFIG_PATH}.`
      : `Config file ${CONFIG_PATH} is missing value(s): ${missing.join(", ")}.`;
    throw new Error(
      `${lead} Open it and fill in:\n` +
        `  baseUrl        - your Sentry host, defaults to ${DEFAULT_BASE_URL} (change only for self-hosted)\n` +
        `  organization   - your Sentry organization slug, e.g. your-org-slug\n` +
        `  authToken      - a Sentry user auth token with the read scopes event:read, project:read, org:read (${PERMISSIONS_DOC})\n` +
        `  defaultProject - optional project slug used as the default filter for search_issues\n` +
        `Then reconnect the sentry server.`
    );
  }

  // Normalise the base URL: require https so endpoint concatenation is
  // predictable and the token is never sent in the clear.
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid URL: "${rawBaseUrl}" (in ${CONFIG_PATH})`);
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error(`baseUrl must use https, got "${baseUrl.protocol}" (in ${CONFIG_PATH})`);
  }

  return {
    baseUrl: baseUrl.origin,
    organization,
    authToken,
    defaultProject,
  };
}

/** The token scope a given API path needs, used to make 403s actionable. */
function scopeForPath(path) {
  if (path.includes("/projects/")) return "project:read (and org:read)";
  if (path.includes("/shortids/")) return "org:read";
  return "event:read";
}

/**
 * Read-only Sentry client. Every method issues an authenticated GET.
 */
export class SentryClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.organization = config.organization;
    this.defaultProject = config.defaultProject;
    this.authHeader = `Bearer ${config.authToken}`;
    // Kept only so redact() can strip the token out of any text built from a
    // response body. It is never logged or written anywhere.
    this.#token = config.authToken;
  }

  #token = "";

  // Caches for the process lifetime: project slug -> numeric id, and
  // short id -> numeric issue id. Both mappings are stable, so one GET each.
  #projectIds = new Map();
  #issueIds = new Map();

  /** Replaces any occurrence of the auth token with a redaction marker. */
  redact(text) {
    const str = (text ?? "").toString();
    return this.#token ? str.split(this.#token).join("[redacted]") : str;
  }

  /** Turns a failed response into an actionable message. */
  #describeError(status, statusText, path, bodyText, headers) {
    const snippet = this.redact((bodyText ?? "").slice(0, 500));
    if (status === 401) {
      return (
        `Sentry rejected the auth token (401) for ${path}. The token is invalid, expired, or revoked - ` +
        `re-check authToken in ${CONFIG_PATH}.`
      );
    }
    if (status === 403) {
      return (
        `Sentry refused the request (403) for ${path}. The token is missing a scope: this endpoint needs ` +
        `${scopeForPath(path)}. Add it to the token (${PERMISSIONS_DOC}) and reconnect the sentry server.`
      );
    }
    if (status === 404) {
      return (
        `Sentry returned 404 for ${path}. The organization slug, project slug, issue id or event id does ` +
        `not exist, or is not visible to this token.`
      );
    }
    if (status === 429) {
      const retryAfter = headers?.get?.("retry-after");
      return (
        `Sentry rate limited the request (429) for ${path}.` +
        (retryAfter ? ` Retry-After: ${retryAfter}s.` : " Retry shortly.")
      );
    }
    return `Sentry returned ${status} ${statusText} for ${path}: ${snippet}`;
  }

  /**
   * Issues an authenticated GET against a Sentry API path. This is the ONLY
   * place fetch() is called in this power, and the only HTTP method it uses.
   *
   * @param {string} path e.g. "/api/0/organizations/acme/projects/"
   * @param {Record<string, string|number|Array<string|number>>} [query]
   * @returns {Promise<{ body: any, headers: Headers }>}
   */
  async get(path, query) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        // Empty strings are kept on purpose: query="" is how a caller asks
        // Sentry for all issues rather than the default is:unresolved.
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(key, String(item));
          }
          continue;
        }
        url.searchParams.append(key, String(value));
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });
    } catch (cause) {
      throw new Error(`Network error calling Sentry (${url.pathname}): ${cause.message}`);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(
        this.#describeError(
          response.status,
          response.statusText,
          url.pathname,
          bodyText,
          response.headers
        )
      );
    }

    if (!bodyText) return { body: {}, headers: response.headers };
    try {
      return { body: JSON.parse(bodyText), headers: response.headers };
    } catch {
      throw new Error(`Sentry returned a non-JSON response for ${url.pathname}`);
    }
  }

  /** GET returning the parsed body only. */
  async getJson(path, query) {
    const { body } = await this.get(path, query);
    return body;
  }

  /**
   * GET for a list endpoint. Returns the first page only - no cursor following.
   * Sentry signals further pages in the Link header, as rel="next" with
   * results="true".
   *
   * @returns {Promise<{ data: any[], hasMore: boolean }>}
   */
  async getList(path, query) {
    const { body, headers } = await this.get(path, query);
    return {
      data: Array.isArray(body) ? body : [],
      ...parseNextLink(headers),
    };
  }

  /**
   * GET for a list endpoint that wraps its rows in an object, as the events
   * endpoint does with { data, meta }. Kept separate from getList so the
   * array-shaped endpoints keep their existing contract.
   *
   * @returns {Promise<{ data: any[], meta: any, hasMore: boolean, nextCursor?: string }>}
   */
  async getDataList(path, query) {
    const { body, headers } = await this.get(path, query);
    return {
      data: Array.isArray(body?.data) ? body.data : [],
      meta: body?.meta,
      ...parseNextLink(headers),
    };
  }

  #orgPath(suffix) {
    return `/api/0/organizations/${encodeURIComponent(this.organization)}/${suffix}`;
  }

  /**
   * GET /api/0/organizations/{org}/projects/
   *
   * This is the one list endpoint that follows the cursor. Other tools resolve a
   * project slug against this result, so a short page would not merely truncate
   * the listing, it would make a valid slug look nonexistent.
   */
  async listProjects() {
    const all = [];
    let cursor;
    for (let page = 0; page < PROJECT_PAGE_CAP; page += 1) {
      const result = await this.getList(this.#orgPath("projects/"), { cursor });
      all.push(...result.data);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { data: all, hasMore: Boolean(cursor) };
  }

  /** GET /api/0/organizations/{org}/issues/ */
  async searchIssues({ query, project, statsPeriod, sort, limit, environment }) {
    return this.getList(this.#orgPath("issues/"), {
      query,
      project,
      statsPeriod,
      sort,
      limit,
      environment,
      // No collapse: collapse=stats also strips count, userCount, firstSeen and
      // lastSeen, which the issue list renders.
    });
  }

  /**
   * GET /api/0/organizations/{org}/events/ against the logs dataset, which backs
   * Explore > Logs. Returns { data, meta } rather than a bare array.
   */
  async searchLogs({ query, project, statsPeriod, environment, fields, limit, sort, cursor }) {
    // This endpoint accepts a project slug directly, so no resolveProjectId hop
    // is needed here (unlike searchIssues, which takes numeric ids only).
    return this.getDataList(this.#orgPath("events/"), {
      dataset: "logs",
      field: fields,
      query,
      project,
      statsPeriod,
      environment,
      per_page: limit,
      sort,
      cursor,
    });
  }

  /** GET /api/0/organizations/{org}/issues/{id}/ */
  async getIssue(issueId) {
    return this.getJson(this.#orgPath(`issues/${encodeURIComponent(issueId)}/`));
  }

  /** GET /api/0/organizations/{org}/issues/{id}/events/{eventId}/ */
  async getEvent(issueId, eventId, environment) {
    return this.getJson(
      this.#orgPath(
        `issues/${encodeURIComponent(issueId)}/events/${encodeURIComponent(eventId)}/`
      ),
      { environment }
    );
  }

  /** GET /api/0/organizations/{org}/issues/{id}/tags/ */
  async getIssueTags(issueId, environment) {
    return this.getJson(this.#orgPath(`issues/${encodeURIComponent(issueId)}/tags/`), {
      environment,
    });
  }

  /** GET /api/0/organizations/{org}/issues/{id}/tags/{key}/ */
  async getIssueTagKey(issueId, key, environment) {
    return this.getJson(
      this.#orgPath(
        `issues/${encodeURIComponent(issueId)}/tags/${encodeURIComponent(key)}/`
      ),
      { environment }
    );
  }

  /** GET /api/0/organizations/{org}/shortids/{shortId}/ */
  async resolveShortId(shortId) {
    return this.getJson(this.#orgPath(`shortids/${encodeURIComponent(shortId)}/`));
  }

  /**
   * Resolves a project slug to the numeric id the issues endpoint has always
   * accepted. Numeric input passes straight through. The slug table is fetched
   * once and cached for the process life.
   */
  async resolveProjectId(slugOrId) {
    const value = (slugOrId ?? "").toString().trim();
    if (!value) return undefined;
    if (/^\d+$/.test(value)) return value;

    if (this.#projectIds.size === 0) {
      const { data } = await this.listProjects();
      for (const project of data) {
        if (project?.slug && project?.id) this.#projectIds.set(project.slug, String(project.id));
      }
    }

    const id = this.#projectIds.get(value);
    if (id) return id;
    const known = [...this.#projectIds.keys()].sort().join(", ") || "(none visible to this token)";
    throw new Error(
      `No project with slug "${value}" in organization "${this.organization}". Available slugs: ${known}`
    );
  }

  /**
   * Resolves a short id such as MYAPP-4F2 to the numeric group id the issue
   * endpoints expect. Numeric input passes straight through.
   */
  async resolveIssueId(idOrShortId) {
    const value = (idOrShortId ?? "").toString().trim();
    if (/^\d+$/.test(value)) return value;

    const cached = this.#issueIds.get(value);
    if (cached) return cached;

    const resolved = await this.resolveShortId(value);
    const id = resolved?.group?.id ?? resolved?.groupId;
    if (!id) {
      throw new Error(
        `Could not resolve "${value}" to a Sentry issue id. Pass the numeric issue id or a valid short id such as MYAPP-4F2.`
      );
    }
    this.#issueIds.set(value, String(id));
    return String(id);
  }

  /** Primes the project slug -> id cache from an already-fetched project list. */
  cacheProjects(projects) {
    for (const project of projects ?? []) {
      if (project?.slug && project?.id) this.#projectIds.set(project.slug, String(project.id));
    }
  }
}
