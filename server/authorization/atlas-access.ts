import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../db/client";
import { atlases } from "../db/app-schema";
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

export async function requireOrganizationMembership(
  request: Request,
  action: AtlasAction,
) {
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

  const member = await auth.api.getActiveMember({ headers: request.headers });
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

  return { session, member, organizationId };
}

export async function requireAtlasAccess(
  request: Request,
  action: AtlasAction,
) {
  const membership = await requireOrganizationMembership(request, action);
  const [atlas] = await db
    .select()
    .from(atlases)
    .where(eq(atlases.organizationId, membership.organizationId))
    .limit(1);

  if (!atlas) {
    throw new AtlasAccessError(404, "ATLAS_NOT_FOUND", "Atlas not found");
  }

  return { ...membership, atlas };
}
