import "server-only";

import { and, asc, eq } from "drizzle-orm";

import {
  accessRoles,
  DEFAULT_ORGANIZATION_ID,
  inventoryTypeDefinitions,
  organizationMemberships,
  organizations,
  relationTypeDefinitions,
  translationLanguages,
  type UserRole,
} from "@/db/schema";
import { builtinRolePermissions } from "@/lib/access-control-contract";
import { db } from "@/lib/db";
import {
  canonicalInventoryTypes,
  canonicalRelationTypes,
  organizationSystemRoles,
} from "@/lib/organization-defaults";
import { slugifyOrganizationName } from "@/lib/organization-path";

export const ORGANIZATION_HEADER = "x-organization-id";
export const ORGANIZATION_COOKIE = "inventory.organization";
export const ORGANIZATION_ROUTE_HEADER = "x-inventory-organization-route";

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  isReadOnly: boolean;
  allowNegativeStock: boolean;
  labelQrRedirectUrl: string | null;
};

export type OrganizationMembershipSummary = OrganizationSummary & {
  role: UserRole;
  roleName: string;
};

// New organizations are seeded from immutable application-owned templates.
// Never copy these rows from an existing organization: its labels, descriptions,
// and translation instructions are tenant-editable data.
export const organizationSummary = (
  organization: Pick<
    typeof organizations.$inferSelect,
    "id" | "name" | "slug" | "isReadOnly" | "allowNegativeStock" | "labelQrRedirectUrl"
  >,
): OrganizationSummary => ({
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
  isReadOnly: organization.isReadOnly,
  allowNegativeStock: organization.allowNegativeStock,
  labelQrRedirectUrl: organization.labelQrRedirectUrl,
});

export async function getOrganization(id: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return organization ?? null;
}

export async function listOrganizationsForUser(
  userId: string,
): Promise<OrganizationMembershipSummary[]> {
  const rows = await db
    .select({
      organization: organizations,
      role: organizationMemberships.roleKey,
      roleName: accessRoles.name,
    })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizationMemberships.organizationId, organizations.id),
    )
    .innerJoin(
      accessRoles,
      and(
        eq(accessRoles.organizationId, organizationMemberships.organizationId),
        eq(accessRoles.key, organizationMemberships.roleKey),
      ),
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.isActive, true),
      ),
    )
    .orderBy(asc(organizations.name), asc(organizations.id));

  return rows.map(({ organization, role, roleName }) => ({
    ...organizationSummary(organization),
    role,
    roleName,
  }));
}

export async function listOrganizations() {
  const rows = await db
    .select()
    .from(organizations)
    .orderBy(asc(organizations.name), asc(organizations.id));
  return rows.map(organizationSummary);
}

export function selectOrganization(
  memberships: readonly OrganizationMembershipSummary[],
  requestedReference?: string | null,
  fallbackReference?: string | null,
  allowSlug = false,
) {
  const matches = (
    membership: OrganizationMembershipSummary,
    reference: string,
  ) =>
    membership.id === reference ||
    (allowSlug && membership.slug === reference.toLowerCase());
  const requested = requestedReference?.trim();
  if (requested) {
    return memberships.find((membership) => matches(membership, requested)) ?? null;
  }
  const fallback = fallbackReference?.trim();
  if (fallback) {
    const match = memberships.find((membership) => matches(membership, fallback));
    if (match) return match;
  }
  return (
    memberships.find(
      (membership) => membership.id === DEFAULT_ORGANIZATION_ID,
    ) ?? memberships[0] ?? null
  );
}

export async function ensureDefaultOrganizationMembership(options: {
  userId: string;
  role: UserRole;
  actor: string;
}) {
  await db
    .insert(organizationMemberships)
    .values({
      organizationId: DEFAULT_ORGANIZATION_ID,
      userId: options.userId,
      roleKey: options.role,
      createdBy: options.actor,
    })
    .onConflictDoNothing({
      target: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    });
}

async function copyOrganizationDefaults(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  actor: string,
) {
  await transaction.insert(accessRoles).values(
    organizationSystemRoles.map((role) => ({
      organizationId,
      ...role,
      permissions: [...builtinRolePermissions[role.key]],
      isSystem: true,
      createdBy: actor,
      updatedBy: actor,
    })),
  );

  await transaction.insert(inventoryTypeDefinitions).values(
    canonicalInventoryTypes.map((type) => ({
      organizationId,
      ...type,
      isSystem: true,
      createdBy: actor,
      updatedBy: actor,
    })),
  );
  await transaction.insert(relationTypeDefinitions).values(
    canonicalRelationTypes.map((relation) => ({
      organizationId,
      ...relation,
      isSystem: true,
      createdBy: actor,
      updatedBy: actor,
    })),
  );
  await transaction.insert(translationLanguages).values({
    organizationId,
    code: "en",
    label: "English",
    isDefault: true,
    autoTranslate: false,
    instructions: "",
    position: 0,
    createdBy: actor,
    updatedBy: actor,
  });
}

export async function createOrganization(options: {
  name: string;
  slug?: string;
  userId: string;
  actor: string;
}) {
  return db.transaction(async (transaction) => {
    const base = options.slug ?? slugifyOrganizationName(options.name);
    let created: typeof organizations.$inferSelect | undefined;
    const attempts = options.slug ? 1 : 25;
    for (let attempt = 0; attempt < attempts && !created; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const slug = `${base.slice(0, 48 - suffix.length)}${suffix}`;
      [created] = await transaction
        .insert(organizations)
        .values({
          name: options.name,
          slug,
          createdBy: options.actor,
        })
        .onConflictDoNothing({ target: organizations.slug })
        .returning();
    }
    if (!created) throw new OrganizationSlugUnavailableError();

    await copyOrganizationDefaults(
      transaction,
      created.id,
      options.actor,
    );
    await transaction.insert(organizationMemberships).values({
      organizationId: created.id,
      userId: options.userId,
      roleKey: "admin",
      createdBy: options.actor,
    });
    return organizationSummary(created);
  });
}

export async function updateOrganization(options: {
  id: string;
  name?: string;
  slug?: string;
  allowNegativeStock?: boolean;
  labelQrRedirectUrl?: string | null;
  actor: string;
}) {
  try {
    const [updated] = await db
      .update(organizations)
      .set({
        ...(options.name ? { name: options.name } : {}),
        ...(options.slug ? { slug: options.slug } : {}),
        ...(options.allowNegativeStock !== undefined
          ? { allowNegativeStock: options.allowNegativeStock }
          : {}),
        ...(options.labelQrRedirectUrl !== undefined
          ? { labelQrRedirectUrl: options.labelQrRedirectUrl }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, options.id))
      .returning();
    return updated ? organizationSummary(updated) : null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new OrganizationSlugUnavailableError();
    }
    throw error;
  }
}

export class OrganizationSlugUnavailableError extends Error {
  constructor() {
    super("Organization slug is already in use.");
    this.name = "OrganizationSlugUnavailableError";
  }
}
