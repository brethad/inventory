export const LOCAL_PREVIEW_ORGANIZATION_ID =
  "10ca1000-0000-4000-8000-000000000001";
export const LOCAL_PREVIEW_USER_ID = "10ca1000-0000-4000-8000-000000000002";
export const LOCAL_PREVIEW_ORGANIZATION_SLUG = "local-preview";
export const LOCAL_PREVIEW_ORGANIZATION_NAME = "Local preview";
export const LOCAL_PREVIEW_USER_EMAIL = "local-preview@inventory.invalid";
export const LOCAL_PREVIEW_USER_NAME = "Local preview";
export const LOCAL_PREVIEW_ACTOR = "local-no-auth-seed";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

type Environment = Record<string, string | undefined>;

function setting(environment: Environment, name: string) {
  return environment[name]?.trim() ?? "";
}

export function isLocalNoAuthEnabled(environment: Environment = process.env) {
  return setting(environment, "LOCAL_NO_AUTH").toLowerCase() === "true";
}

export function isLoopbackHostname(hostname: string) {
  let normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.startsWith("::ffff:")) {
    normalized = normalized.slice("::ffff:".length);
  }
  return LOOPBACK_HOSTS.has(normalized);
}

function ipv4Parts(host: string) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return null;
  return parts;
}

// Next.js records the TCP peer in X-Forwarded-For. Docker's published-port
// proxy uses a private bridge address even when the browser opened 127.0.0.1.
export function isLocalOrPrivatePeer(value: string) {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.includes("]")) {
    host = host.slice(1, host.indexOf("]"));
  }
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) host = mapped[1];
  const v4WithPort = host.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) host = v4WithPort[1];
  if (isLoopbackHostname(host)) return true;

  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (!host.includes(":")) return false;
  const head = Number.parseInt(host.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(head)) return false;
  // Unique local fc00::/7 and link-local fe80::/10.
  if ((head & 0xfe00) === 0xfc00) return true;
  if ((head & 0xffc0) === 0xfe80) return true;
  return false;
}

export function hostnameFromHostHeader(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end) : "";
  }
  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon > -1 && firstColon === lastColon) {
    return trimmed.slice(0, firstColon);
  }
  return trimmed;
}

export function localNoAuthRequestAllowed(input: {
  host?: string | null;
  forwardedHost?: string | null;
  forwardedFor?: string | null;
  origin?: string | null;
  fetchSite?: string | null;
}) {
  const host = hostnameFromHostHeader(input.host);
  if (!host || !isLoopbackHostname(host)) return false;

  const forwardedHost = input.forwardedHost?.split(",")[0]?.trim() ?? "";
  if (
    forwardedHost &&
    !isLoopbackHostname(hostnameFromHostHeader(forwardedHost))
  ) {
    return false;
  }

  const forwardedFor = input.forwardedFor?.split(",")[0]?.trim() ?? "";
  // A public peer means the request did not come from this machine. Docker's
  // bridge address is private and is allowed. The Host itself must still be
  // loopback, so a forwarded public name is refused above.
  if (forwardedFor && !isLocalOrPrivatePeer(forwardedFor)) {
    return false;
  }

  if (input.origin) {
    try {
      const url = new URL(input.origin);
      if (!isLoopbackHostname(url.hostname)) return false;
    } catch {
      return false;
    }
  }

  if (input.fetchSite?.trim().toLowerCase() === "cross-site") return false;
  return true;
}

export function localNoAuthDeniesCredentialIssuance(
  identity: { localNoAuth?: boolean } | null | undefined,
) {
  return identity?.localNoAuth === true;
}

export function validateLocalNoAuthEnvironment(
  environment: Environment = process.env,
) {
  const errors: string[] = [];
  const configured = setting(environment, "LOCAL_NO_AUTH").toLowerCase();
  if (configured && configured !== "true" && configured !== "false") {
    errors.push("LOCAL_NO_AUTH must be either true or false when set.");
  }
  if (configured !== "true") return errors;

  const authUrl = setting(environment, "AUTH_URL");
  if (!authUrl) {
    errors.push(
      "LOCAL_NO_AUTH requires AUTH_URL on a loopback host, such as http://127.0.0.1:3000.",
    );
  } else {
    try {
      const url = new URL(authUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !isLoopbackHostname(url.hostname)
      ) {
        errors.push(
          "LOCAL_NO_AUTH requires AUTH_URL to use http or https on localhost, 127.0.0.1, or ::1. Public hostnames are refused.",
        );
      }
    } catch {
      errors.push("LOCAL_NO_AUTH requires AUTH_URL to be an absolute loopback URL.");
    }
  }

  const reservedEmails = [
    ["SIMPLE_AUTH_EMAIL", setting(environment, "SIMPLE_AUTH_EMAIL")],
    ["BOOTSTRAP_ADMIN_EMAIL", setting(environment, "BOOTSTRAP_ADMIN_EMAIL")],
  ] as const;
  for (const [name, email] of reservedEmails) {
    if (email.toLowerCase() === LOCAL_PREVIEW_USER_EMAIL) {
      errors.push(
        `${name} must not reuse the reserved local preview account ${LOCAL_PREVIEW_USER_EMAIL}.`,
      );
    }
  }
  const superadmins = setting(environment, "SUPERADMIN_EMAILS")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (superadmins.includes(LOCAL_PREVIEW_USER_EMAIL)) {
    errors.push(
      "SUPERADMIN_EMAILS must not include the local preview account. The preview stays inside its own organization.",
    );
  }
  return errors;
}
