import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { apiTokens, users } from "../db/schema.ts";
import {
  LOCAL_PREVIEW_ORGANIZATION_ID,
  LOCAL_PREVIEW_USER_EMAIL,
  LOCAL_PREVIEW_USER_ID,
} from "../lib/local-no-auth.ts";

const realUserId = "11111111-1111-4111-8111-111111111111";
const realOrganizationId = "22222222-2222-4222-8222-222222222222";
const adminPermissions = [
  "inventory.read",
  "inventory.create",
  "inventory.update",
  "inventory.delete",
  "spatial.read",
  "spatial.manage",
];

let session = null;
let dbUser = null;
let memberships = [];
let role = null;
let host = "127.0.0.1:3000";
let forwardedHost = null;
let forwardedFor = null;
let origin = null;
let fetchSite = null;
let userReads = 0;
let tokenReads = 0;
let headerReads = 0;

const localUser = () => ({
  id: LOCAL_PREVIEW_USER_ID,
  email: LOCAL_PREVIEW_USER_EMAIL,
  name: "Local preview",
  isActive: true,
  sessionVersion: 1,
  inventoryPageSize: 50,
  developerMode: true,
});

const localMembership = () => ({
  id: LOCAL_PREVIEW_ORGANIZATION_ID,
  name: "Local preview",
  slug: "local-preview",
  isReadOnly: false,
  allowNegativeStock: false,
  labelQrRedirectUrl: null,
  role: "admin",
  roleName: "Admin",
});

const realUser = () => ({
  id: realUserId,
  email: "admin@inventory.local",
  name: "Inventory admin",
  isActive: true,
  sessionVersion: 1,
  inventoryPageSize: 50,
  developerMode: true,
});

const realMembership = () => ({
  id: realOrganizationId,
  name: "Workshop",
  slug: "workshop",
  isReadOnly: false,
  allowNegativeStock: false,
  labelQrRedirectUrl: null,
  role: "admin",
  roleName: "Admin",
});

beforeEach(() => {
  process.env.LOCAL_NO_AUTH = "true";
  process.env.AUTH_URL = "http://127.0.0.1:3000";
  session = null;
  dbUser = localUser();
  memberships = [localMembership()];
  role = {
    key: "admin",
    name: "Admin",
    isSystem: true,
    permissions: [...adminPermissions],
  };
  host = "127.0.0.1:3000";
  forwardedHost = null;
  forwardedFor = null;
  origin = null;
  fetchSite = null;
  userReads = 0;
  tokenReads = 0;
  headerReads = 0;
});

mock.module("../auth.ts", {
  namedExports: {
    auth: async () => session,
    demoAccessEnabled: false,
  },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => ({
      get: (name) => {
        headerReads += 1;
        if (name === "host") return host;
        if (name === "x-forwarded-host") return forwardedHost;
        if (name === "x-forwarded-for") return forwardedFor;
        if (name === "origin") return origin;
        if (name === "sec-fetch-site") return fetchSite;
        return null;
      },
    }),
  },
});
mock.module("../lib/db.ts", {
  namedExports: {
    db: {
      select: () => ({
        from: (table) => ({
          where: () => ({
            limit: async () => {
              if (table === apiTokens) {
                tokenReads += 1;
                return [];
              }
              if (table === users) {
                userReads += 1;
                return dbUser ? [dbUser] : [];
              }
              throw new Error(`Unexpected query table ${table}`);
            },
          }),
        }),
      }),
    },
  },
});
mock.module("../lib/deployment-access.ts", {
  namedExports: { isSuperAdminEmail: () => true },
});
mock.module("../lib/access-control.ts", {
  namedExports: {
    conditionalScopesForRole: async () => [],
    getEffectiveRole: async () => role,
    getResourceRecord: async () => null,
    listRulesForRole: async () => [],
    permissionsForStandaloneTokenScopes: () => [],
    roleScopesForPermissions: () => ["read", "write", "ai"],
    ruleGrantsResourcePermission: () => false,
  },
});
mock.module("../lib/organizations.ts", {
  namedExports: {
    ORGANIZATION_COOKIE: "inventory.organization",
    ORGANIZATION_HEADER: "x-organization-id",
    ORGANIZATION_ROUTE_HEADER: "x-inventory-organization-route",
    getOrganization: async () => null,
    organizationSummary: (organization) => organization,
    listOrganizationsForUser: async () => memberships,
    selectOrganization: (available, requested) => {
      const reference = requested?.trim();
      if (!reference) return available[0] ?? null;
      return (
        available.find(
          (membership) =>
            membership.id === reference || membership.slug === reference.toLowerCase(),
        ) ?? null
      );
    },
  },
});
mock.module("../lib/resource-slugs.ts", {
  namedExports: { resolveResourceId: async () => null },
});

const { getRequestIdentity, getSessionIdentity, requirePermission } = await import(
  "../lib/api-auth.ts"
);

const anonymous = (extraHeaders = {}) =>
  new Request("http://127.0.0.1:3000/api/v1/resources", { headers: extraHeaders });

test("an anonymous loopback request becomes the writable preview admin", async () => {
  const identity = await getRequestIdentity(anonymous());
  assert.equal(identity.localNoAuth, true);
  assert.equal(identity.kind, "session");
  assert.equal(identity.userId, LOCAL_PREVIEW_USER_ID);
  assert.equal(identity.organizationId, LOCAL_PREVIEW_ORGANIZATION_ID);
  assert.equal(identity.organization.slug, "local-preview");
  assert.equal(identity.organization.isReadOnly, false);
  assert.equal(identity.isSuperAdmin, false);
  assert.equal(identity.developerMode, false);
  assert.equal(identity.permissions.includes("inventory.create"), true);
  assert.equal(identity.permissions.includes("inventory.delete"), true);
  assert.equal(identity.scopes.includes("write"), true);
  assert.equal((await requirePermission(anonymous(), "inventory.create")).response, null);
  assert.equal((await requirePermission(anonymous(), "spatial.manage")).response, null);
});

test("the same request is unauthorized when the flag is off or the host is not loopback", async () => {
  delete process.env.LOCAL_NO_AUTH;
  assert.equal(await getSessionIdentity(), null);
  assert.equal(headerReads, 0);
  assert.equal(userReads, 0);

  process.env.LOCAL_NO_AUTH = "true";
  host = "192.168.1.20:3000";
  assert.equal(await getRequestIdentity(anonymous()), null);
  assert.equal(userReads, 0);

  host = "127.0.0.1:3000";
  forwardedFor = "198.51.100.20";
  assert.equal(await getRequestIdentity(anonymous()), null);
  origin = "https://example.test";
  forwardedFor = null;
  assert.equal(await getRequestIdentity(anonymous()), null);
});

test("a bearer token does not fall through to the preview principal", async () => {
  const request = anonymous({
    authorization: "Bearer inv_this_token_is_not_in_the_database_00",
  });
  assert.equal(await getRequestIdentity(request), null);
  assert.equal(tokenReads, 1);
  assert.equal(userReads, 0);
});

test("an authenticated session keeps its own organization", async () => {
  session = {
    user: {
      id: realUserId,
      email: "admin@inventory.local",
      name: "Inventory admin",
      role: "admin",
      authProvider: "local",
      sessionVersion: 1,
    },
  };
  dbUser = realUser();
  memberships = [realMembership()];
  const identity = await getSessionIdentity();
  assert.equal(identity.organizationId, realOrganizationId);
  assert.equal(identity.localNoAuth, undefined);
  assert.equal(identity.isSuperAdmin, true);
  assert.equal(identity.userId, realUserId);
});

test("a widened or read-only preview membership fails closed", async () => {
  memberships = [localMembership(), realMembership()];
  assert.equal(await getRequestIdentity(anonymous()), null);

  memberships = [{ ...localMembership(), isReadOnly: true }];
  assert.equal(await getRequestIdentity(anonymous()), null);

  memberships = [{ ...localMembership(), role: "viewer" }];
  assert.equal(await getRequestIdentity(anonymous()), null);

  memberships = [localMembership()];
  role = { ...role, isSystem: false };
  assert.equal(await getRequestIdentity(anonymous()), null);

  role = { ...role, isSystem: true, permissions: ["inventory.read"] };
  assert.equal(await getRequestIdentity(anonymous()), null);
});
