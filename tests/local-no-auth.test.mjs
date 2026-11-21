import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateAuthProviderEnvironment } from "../lib/auth-provider-config.ts";
import {
  LOCAL_PREVIEW_ORGANIZATION_ID,
  LOCAL_PREVIEW_USER_EMAIL,
  LOCAL_PREVIEW_USER_ID,
  isLocalNoAuthEnabled,
  isLoopbackHostname,
  localNoAuthDeniesCredentialIssuance,
  localNoAuthRequestAllowed,
  validateLocalNoAuthEnvironment,
} from "../lib/local-no-auth.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("local no-auth stays off unless explicitly enabled", () => {
  assert.equal(isLocalNoAuthEnabled({}), false);
  assert.equal(isLocalNoAuthEnabled({ LOCAL_NO_AUTH: "false" }), false);
  assert.equal(isLocalNoAuthEnabled({ LOCAL_NO_AUTH: " true " }), true);
  assert.deepEqual(validateLocalNoAuthEnvironment({}), []);
  assert.match(
    validateLocalNoAuthEnvironment({ LOCAL_NO_AUTH: "yes" }).join(" "),
    /must be either true or false/,
  );
});

test("enabling local no-auth requires a loopback AUTH_URL and a separate account", () => {
  assert.match(
    validateLocalNoAuthEnvironment({ LOCAL_NO_AUTH: "true" }).join(" "),
    /AUTH_URL/,
  );
  assert.match(
    validateLocalNoAuthEnvironment({
      LOCAL_NO_AUTH: "true",
      AUTH_URL: "https://inventory.example",
    }).join(" "),
    /Public hostnames are refused/,
  );
  assert.deepEqual(
    validateLocalNoAuthEnvironment({
      LOCAL_NO_AUTH: "true",
      AUTH_URL: "http://127.0.0.1:3000",
    }),
    [],
  );
  assert.match(
    validateLocalNoAuthEnvironment({
      LOCAL_NO_AUTH: "true",
      AUTH_URL: "http://localhost:3000",
      SIMPLE_AUTH_EMAIL: LOCAL_PREVIEW_USER_EMAIL,
      SUPERADMIN_EMAILS: `admin@inventory.local, ${LOCAL_PREVIEW_USER_EMAIL}`,
    }).join(" "),
    /SIMPLE_AUTH_EMAIL[\s\S]*SUPERADMIN_EMAILS/,
  );
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackHostname("inventory.local"), false);
});

test("anonymous preview requests must be direct loopback requests", () => {
  assert.equal(
    localNoAuthRequestAllowed({ host: "127.0.0.1:3000" }),
    true,
  );
  assert.equal(localNoAuthRequestAllowed({ host: "localhost:3000" }), true);
  assert.equal(localNoAuthRequestAllowed({ host: "[::1]:3000" }), true);
  assert.equal(localNoAuthRequestAllowed({ host: "10.0.0.8:3000" }), false);
  assert.equal(localNoAuthRequestAllowed({}), false);
  assert.equal(
    localNoAuthRequestAllowed({
      host: "127.0.0.1:3000",
      forwardedHost: "inventory.example",
    }),
    false,
  );
  assert.equal(
    localNoAuthRequestAllowed({
      host: "127.0.0.1:3000",
      forwardedFor: "203.0.113.10",
    }),
    false,
  );
  assert.equal(
    localNoAuthRequestAllowed({
      host: "127.0.0.1:3000",
      forwardedFor: "127.0.0.1",
    }),
    true,
  );
  assert.equal(
    localNoAuthRequestAllowed({
      host: "localhost:3000",
      origin: "http://localhost:3000",
    }),
    true,
  );
  assert.equal(
    localNoAuthRequestAllowed({
      host: "127.0.0.1:3000",
      origin: "https://evil.example",
    }),
    false,
  );
  assert.equal(
    localNoAuthRequestAllowed({
      host: "127.0.0.1:3000",
      fetchSite: "cross-site",
    }),
    false,
  );
});

test("loopback local no-auth can be the only access method", () => {
  const disabled = validateAuthProviderEnvironment({
    AUTH_PASSWORD_ENABLED: "false",
  });
  assert.match(disabled.errors.join(" "), /At least one authentication provider/);

  const preview = validateAuthProviderEnvironment({
    AUTH_PASSWORD_ENABLED: "false",
    LOCAL_NO_AUTH: "true",
    AUTH_URL: "http://127.0.0.1:3000",
  });
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.configuration.passwordEnabled, false);

  const published = validateAuthProviderEnvironment({
    LOCAL_NO_AUTH: "true",
    AUTH_URL: "https://inventory.example",
  });
  assert.match(published.errors.join(" "), /Public hostnames are refused/);
});

test("the preview identity cannot mint credentials", () => {
  assert.equal(localNoAuthDeniesCredentialIssuance({ localNoAuth: true }), true);
  assert.equal(localNoAuthDeniesCredentialIssuance({ localNoAuth: false }), false);
  assert.equal(localNoAuthDeniesCredentialIssuance(null), false);
});

test("startup reconciles only the fixed preview principal and does not delete rows", async () => {
  const [seed, startup, dockerfile, tokens, nativeSession] = await Promise.all([
    read("../scripts/seed-local-preview.mjs"),
    read("../scripts/start-production.mjs"),
    read("../Dockerfile"),
    read("../app/api/tokens/route.ts"),
    read("../lib/native-session.ts"),
  ]);
  assert.match(seed, /LOCAL_NO_AUTH/);
  assert.match(seed, /pg_advisory_xact_lock/);
  assert.match(seed, /LOCAL_PREVIEW_ORGANIZATION_ID/);
  assert.match(seed, /LOCAL_PREVIEW_USER_ID/);
  assert.equal(LOCAL_PREVIEW_ORGANIZATION_ID, "10ca1000-0000-4000-8000-000000000001");
  assert.equal(LOCAL_PREVIEW_USER_ID, "10ca1000-0000-4000-8000-000000000002");
  assert.doesNotMatch(seed, /DELETE FROM/i);
  assert.match(seed, /refusing to seed or merge/);
  assert.match(seed, /left untouched/);
  assert.match(startup, /isLocalNoAuthEnabled\(process\.env\)/);
  assert.match(startup, /import\("\.\/seed-local-preview\.mjs"\)/);
  assert.match(dockerfile, /scripts\/seed-local-preview\.mjs/);
  assert.match(tokens, /localNoAuthDeniesCredentialIssuance/);
  assert.match(nativeSession, /LOCAL_PREVIEW_USER_ID/);
  assert.equal(
    startup.indexOf('import("./seed-local-preview.mjs")') >
      startup.indexOf("isLocalNoAuthEnabled(process.env)"),
    true,
  );
});
