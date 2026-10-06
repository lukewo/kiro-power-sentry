// Trust the operating system's certificate store in addition to Node's bundled
// CA list.
//
// Why this exists: on corporate networks that perform TLS inspection, HTTPS
// traffic is re-signed by an internal root CA. That CA lives in the OS trust
// store (so browsers, PowerShell, etc. work), but Node ships its own bundled CA
// list and ignores the OS store by default. Without this, fetch() to Sentry
// fails with SELF_SIGNED_CERT_IN_CHAIN even though the same request works
// elsewhere.
//
// This merges the system CAs with Node's defaults at runtime, keeping full
// certificate validation on. It is a no-op on machines without an inspecting
// proxy, and degrades gracefully on Node versions that lack the runtime API
// (Node 22+ has it; older versions can use the --use-system-ca flag or
// NODE_EXTRA_CA_CERTS instead).
//
// Importing this module for its side effect must happen before any HTTPS
// request is made.

import tls from "node:tls";

try {
  if (
    typeof tls.getCACertificates === "function" &&
    typeof tls.setDefaultCACertificates === "function"
  ) {
    const bundled = tls.getCACertificates("default");
    const system = tls.getCACertificates("system");
    // De-duplicate so we do not needlessly grow the trust list on repeated certs.
    const merged = Array.from(new Set([...bundled, ...system]));
    tls.setDefaultCACertificates(merged);
  }
} catch (err) {
  // Never block startup over CA setup. If it fails, the connection may still
  // work on non-inspecting networks; if not, the request error will explain it.
  process.stderr.write(`[sentry] system CA trust setup skipped: ${err.message}\n`);
}
