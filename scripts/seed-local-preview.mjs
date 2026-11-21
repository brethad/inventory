import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import { hash } from "bcryptjs";
import postgres from "postgres";

import { builtinRolePermissions } from "../lib/access-control-contract.ts";
import {
  LOCAL_PREVIEW_ACTOR,
  LOCAL_PREVIEW_ORGANIZATION_ID,
  LOCAL_PREVIEW_ORGANIZATION_NAME,
  LOCAL_PREVIEW_ORGANIZATION_SLUG,
  LOCAL_PREVIEW_USER_EMAIL,
  LOCAL_PREVIEW_USER_ID,
  LOCAL_PREVIEW_USER_NAME,
  isLocalNoAuthEnabled,
  validateLocalNoAuthEnvironment,
} from "../lib/local-no-auth.ts";
import {
  canonicalInventoryTypes,
  canonicalRelationTypes,
  organizationSystemRoles,
} from "../lib/organization-defaults.ts";

// Distinct from the demo seed lock. Held only for this transaction.
const LOCAL_PREVIEW_LOCK_ID = 1_001_001_001;

if (process.argv.slice(2).length > 0) {
  throw new Error("seed-local-preview.mjs does not accept arguments and never deletes data.");
}

for (const envFile of [".env.local", ".env"]) {
  if (!existsSync(envFile)) continue;
  process.loadEnvFile(envFile);
}

if (!isLocalNoAuthEnabled(process.env)) {
  process.stdout.write(
    "Local preview seed skipped; set LOCAL_NO_AUTH=true to create or reconcile it.\n",
  );
  process.exit(0);
}

const configurationErrors = validateLocalNoAuthEnvironment(process.env);
if (configurationErrors.length > 0) {
  throw new Error(configurationErrors.join(" "));
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed the local preview organization.");
}

const sql = postgres(databaseUrl, { max: 1 });

async function assertSchemaIsReady(transaction) {
  const [column] = await transaction`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'organizations'
      AND column_name = 'is_read_only'
    LIMIT 1
  `;
  if (!column) {
    throw new Error(
      "The organization migration is missing. Apply database migrations before seeding the local preview.",
    );
  }
}

async function assertIdentitySlotsAreSafe(transaction) {
  const organizations = await transaction`
    SELECT id, slug
    FROM organizations
    WHERE id = ${LOCAL_PREVIEW_ORGANIZATION_ID}
      OR slug = ${LOCAL_PREVIEW_ORGANIZATION_SLUG}
    FOR UPDATE
  `;
  for (const organization of organizations) {
    if (organization.id !== LOCAL_PREVIEW_ORGANIZATION_ID) {
      throw new Error(
        `Local preview slug ${LOCAL_PREVIEW_ORGANIZATION_SLUG} is already owned by another organization; refusing to seed or merge.`,
      );
    }
  }

  const users = await transaction`
    SELECT id, email
    FROM users
    WHERE id = ${LOCAL_PREVIEW_USER_ID}
      OR email = ${LOCAL_PREVIEW_USER_EMAIL}
    FOR UPDATE
  `;
  for (const user of users) {
    if (user.id !== LOCAL_PREVIEW_USER_ID) {
      throw new Error(
        `Local preview email ${LOCAL_PREVIEW_USER_EMAIL} is already owned by another user; refusing to seed or merge.`,
      );
    }
    if (user.email !== LOCAL_PREVIEW_USER_EMAIL) {
      throw new Error(
        `The fixed local preview user already uses ${user.email}; refusing to rename it.`,
      );
    }
  }

  const foreignMemberships = await transaction`
    SELECT organization_id
    FROM organization_memberships
    WHERE user_id = ${LOCAL_PREVIEW_USER_ID}
      AND is_active = true
      AND organization_id <> ${LOCAL_PREVIEW_ORGANIZATION_ID}
    LIMIT 1
  `;
  if (foreignMemberships.length > 0) {
    throw new Error(
      "The local preview user belongs to another organization. Refusing to seed so existing memberships are left untouched.",
    );
  }

  const otherMembers = await transaction`
    SELECT user_id
    FROM organization_memberships
    WHERE organization_id = ${LOCAL_PREVIEW_ORGANIZATION_ID}
      AND is_active = true
      AND user_id <> ${LOCAL_PREVIEW_USER_ID}
    LIMIT 1
  `;
  if (otherMembers.length > 0) {
    throw new Error(
      "Another user already belongs to the local preview organization. Refusing to seed so that membership is left untouched.",
    );
  }
}

async function seedLocalPreview(transaction, passwordHash) {
  await transaction`
    INSERT INTO organizations (
      id, name, slug, is_read_only, created_by, updated_at
    ) VALUES (
      ${LOCAL_PREVIEW_ORGANIZATION_ID},
      ${LOCAL_PREVIEW_ORGANIZATION_NAME},
      ${LOCAL_PREVIEW_ORGANIZATION_SLUG},
      false,
      ${LOCAL_PREVIEW_ACTOR},
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      is_read_only = false,
      updated_at = now()
  `;

  for (const role of organizationSystemRoles) {
    const permissions = builtinRolePermissions[role.key];
    if (!permissions?.length) {
      throw new Error(`Missing builtin permissions for the ${role.key} role.`);
    }
    await transaction`
      INSERT INTO access_roles (
        organization_id, key, name, description, permissions, is_system,
        created_by, updated_by, updated_at
      ) VALUES (
        ${LOCAL_PREVIEW_ORGANIZATION_ID}, ${role.key}, ${role.name},
        ${role.description}, ${permissions}, true,
        ${LOCAL_PREVIEW_ACTOR}, ${LOCAL_PREVIEW_ACTOR}, now()
      )
      ON CONFLICT (organization_id, key) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        permissions = excluded.permissions,
        is_system = true,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
  }

  for (const type of canonicalInventoryTypes) {
    await transaction`
      INSERT INTO inventory_type_definitions (
        organization_id, key, label, description, color, icon, can_contain,
        spatial_containment, position, is_system, created_by, updated_by, updated_at
      ) VALUES (
        ${LOCAL_PREVIEW_ORGANIZATION_ID}, ${type.key}, ${type.label},
        ${type.description}, ${type.color}, ${type.icon}, ${type.canContain},
        ${type.spatialContainment}, ${type.position}, true,
        ${LOCAL_PREVIEW_ACTOR}, ${LOCAL_PREVIEW_ACTOR}, now()
      )
      ON CONFLICT (organization_id, key) DO NOTHING
    `;
  }

  for (const relationType of canonicalRelationTypes) {
    await transaction`
      INSERT INTO relation_type_definitions (
        organization_id, key, label, inverse_label, description, allow_manual,
        spatial, position, is_system, created_by, updated_by, updated_at
      ) VALUES (
        ${LOCAL_PREVIEW_ORGANIZATION_ID}, ${relationType.key}, ${relationType.label},
        ${relationType.inverseLabel}, ${relationType.description},
        ${relationType.allowManual}, ${relationType.spatial}, ${relationType.position},
        true, ${LOCAL_PREVIEW_ACTOR}, ${LOCAL_PREVIEW_ACTOR}, now()
      )
      ON CONFLICT (organization_id, key) DO NOTHING
    `;
  }

  await transaction`
    INSERT INTO translation_languages (
      organization_id, code, label, is_default, auto_translate, instructions,
      position, created_by, updated_by
    ) VALUES (
      ${LOCAL_PREVIEW_ORGANIZATION_ID}, 'en', 'English', true, false, '',
      0, ${LOCAL_PREVIEW_ACTOR}, ${LOCAL_PREVIEW_ACTOR}
    )
    ON CONFLICT (organization_id, code) DO NOTHING
  `;

  await transaction`
    INSERT INTO users (
      id, email, name, password_hash, role, is_active, created_by, updated_by,
      password_updated_at, updated_at
    ) VALUES (
      ${LOCAL_PREVIEW_USER_ID}, ${LOCAL_PREVIEW_USER_EMAIL}, ${LOCAL_PREVIEW_USER_NAME},
      ${passwordHash}, 'admin', true, ${LOCAL_PREVIEW_ACTOR}, ${LOCAL_PREVIEW_ACTOR},
      now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      is_active = true,
      role = 'admin',
      updated_by = excluded.updated_by,
      updated_at = now()
  `;

  await transaction`
    INSERT INTO organization_memberships (
      organization_id, user_id, role_key, is_active, created_by, updated_at
    ) VALUES (
      ${LOCAL_PREVIEW_ORGANIZATION_ID}, ${LOCAL_PREVIEW_USER_ID}, 'admin', true,
      ${LOCAL_PREVIEW_ACTOR}, now()
    )
    ON CONFLICT (organization_id, user_id) DO UPDATE SET
      role_key = 'admin',
      is_active = true,
      updated_at = now()
  `;
}

try {
  // Random and discarded. The preview user has no known password and cannot
  // be used to mint a native or browser credential.
  const passwordHash = await hash(randomBytes(32).toString("base64url"), 12);
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(${LOCAL_PREVIEW_LOCK_ID})`;
    await assertSchemaIsReady(transaction);
    await assertIdentitySlotsAreSafe(transaction);
    await seedLocalPreview(transaction, passwordHash);
  });
  process.stdout.write(
    "Local preview organization is ready. LOCAL_NO_AUTH gives every direct loopback client full read/write access to that organization only. Bind the app to 127.0.0.1 and do not publish it through a tunnel or reverse proxy.\n",
  );
} finally {
  await sql.end();
}
