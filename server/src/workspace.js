// Detects the workspace folder Kiro currently has open.
//
// A power's MCP server is launched with cwd set to the plugin root and an
// environment containing only PLUGIN_ROOT / PLUGIN_DATA (plus PATH, HOME and a
// few shell basics), so there is no direct signal telling us which project the
// user is working in. Kiro does, however, persist its window state - including
// each opened workspace folder - in its global storage file, so we read that.
//
// Caveats, deliberately surfaced to the caller rather than hidden:
//   - This is Kiro's internal state file, not a documented API. A future Kiro
//     release could move or reshape it, in which case detection returns null and
//     the caller falls back to the power's data directory.
//   - With several windows open on different folders we cannot know which one
//     the request came from, so we take the most recently active/opened folder
//     and report that an assumption was made.

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Candidate locations of Kiro's global storage file, per platform. */
function storageCandidates() {
  const home = homedir();
  const p = platform();
  const rel = join("User", "globalStorage", "storage.json");

  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Kiro", rel)];
  }
  if (p === "darwin") {
    return [join(home, "Library", "Application Support", "Kiro", rel)];
  }
  // Linux and anything else XDG-ish.
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(configHome, "Kiro", rel)];
}

/** Converts a stored "file:///..." folder URI to a filesystem path. */
function uriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * Resolves the workspace folder Kiro has open. Issues fetched by this power are
 * written to <workspace>/.sentry, so this is what decides where they land; when
 * it returns null the caller falls back to the kiro-power-sentry data folder.
 *
 * @returns {{ path: string | null, assumed: boolean, reason: string }}
 *   path    - the detected workspace folder, or null if it could not be determined
 *   assumed - true when more than one candidate existed and one was chosen
 *   reason  - short explanation, suitable for surfacing to the user
 */
export function detectWorkspace() {
  const candidates = storageCandidates();
  const storagePath = candidates.find((p) => existsSync(p));
  if (!storagePath) {
    return { path: null, assumed: false, reason: "Kiro window state file not found" };
  }

  let state;
  try {
    state = JSON.parse(readFileSync(storagePath, "utf8"))?.windowsState;
  } catch {
    return { path: null, assumed: false, reason: "Kiro window state file could not be read" };
  }
  if (!state || typeof state !== "object") {
    return { path: null, assumed: false, reason: "no window state recorded" };
  }

  // Collect every window that actually has a folder open, in stored order.
  const opened = Array.isArray(state.openedWindows) ? state.openedWindows : [];
  const folders = opened.map((w) => uriToPath(w?.folder)).filter((p) => p && existsSync(p));

  // The active window is the best signal when it carries a folder.
  const active = uriToPath(state.lastActiveWindow?.folder);
  if (active && existsSync(active)) {
    return {
      path: active,
      assumed: folders.length > 1,
      reason: folders.length > 1 ? "several folders open; used the active window" : "active window",
    };
  }

  if (folders.length === 0) {
    return { path: null, assumed: false, reason: "no workspace folder is open" };
  }

  // Otherwise take the most recently opened folder - the last entry recorded.
  const chosen = folders[folders.length - 1];
  return {
    path: chosen,
    assumed: folders.length > 1,
    reason:
      folders.length > 1
        ? "several folders open; used the most recently opened one"
        : "only open workspace folder",
  };
}
