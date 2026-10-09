import { and, eq, isNull } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../db/client";
import { atlases } from "../db/app-schema";
import { member as authMembers } from "../db/auth-schema";
import {
  hasAtlasPermission,
  type AtlasAction,
} from "./permissions";

export class AtlasAccessError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const memberColumns = {
  id: authMembers.id,
  organizationId: authMembers.organizationId,
  userId: authMembers.userId,
  role: authMembers.role,
};

async function requireActiveOrganizationSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new AtlasAccessError(401, "AUTH_REQUIRED", "Sign in required");
  }

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new AtlasAccessError(
      409,
      "ACTIVE_ORGANIZATION_REQUIRED",
      "Select or create an atlas first",
    );
  }
  return { session, organizationId };
}

/**
 * The member row of the session's own user in the session's active
 * Organization — the same row Better Auth's `getActiveMember` returns, read
 * directly so the session this request already resolved is not resolved a
 * second time.
 */
function activeMemberWhere(userId: string, organizationId: string) {
  return and(
    eq(authMembers.userId, userId),
    eq(authMembers.organizationId, organizationId),
  );
}

function requireMemberPermission(
  member: { organizationId: string; role: string } | undefined,
  organizationId: string,
  action: AtlasAction,
) {
  if (!member || member.organizationId !== organizationId) {
    throw new AtlasAccessError(
      403,
      "ATLAS_MEMBERSHIP_REQUIRED",
      "Atlas membership required",
    );
  }
  if (!hasAtlasPermission(member.role, action)) {
    throw new AtlasAccessError(
      403,
      "ATLAS_PERMISSION_DENIED",
      "Atlas permission denied",
    );
  }
  return member;
}

export async function requireOrganizationMembership(
  request: Request,
  action: AtlasAction,
) {
  const { session, organizationId } = await requireActiveOrganizationSession(request);
  const [row] = await db
    .select(memberColumns)
    .from(authMembers)
    .where(activeMemberWhere(session.user.id, organizationId))
    .limit(1);
  const member = requireMemberPermission(row, organizationId, action);
  return { session, member, organizationId };
}

export async function requireAtlasAccess(
  request: Request,
  action: AtlasAction,
) {
  const { session, organizationId } = await requireActiveOrganizationSession(request);
  // One round trip for the membership and the Organization's live Atlas. The
  // checks still run in the original order: membership, then permission, then
  // the Atlas, so a non-member never learns whether an Atlas exists.
  const [row] = await db
    .select({ member: memberColumns, atlas: atlases })
    .from(authMembers)
    .leftJoin(atlases, and(
      eq(atlases.organizationId, authMembers.organizationId),
      isNull(atlases.deletionStartedAt),
    ))
    .where(activeMemberWhere(session.user.id, organizationId))
    .limit(1);
  const member = requireMemberPermission(row?.member, organizationId, action);
  const atlas = row?.atlas;
  if (!atlas) {
    throw new AtlasAccessError(404, "ATLAS_NOT_FOUND", "Atlas not found");
  }

  return { session, member, organizationId, atlas };
}
