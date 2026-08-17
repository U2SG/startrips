import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  requireAtlasAccess,
  requireOrganizationMembership,
} from "../authorization/atlas-access";
import { db } from "../db/client";
import { atlases } from "../db/app-schema";
import { deleteAtlasForOrganization } from "../services/delete-atlas";

export type AtlasDetails = {
  title: string;
  dedication: string;
};

export function parseAtlasDetails(body: {
  title?: unknown;
  dedication?: unknown;
}): AtlasDetails | null {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const dedication =
    typeof body.dedication === "string" ? body.dedication.trim() : "";
  if (!title || title.length > 80 || dedication.length > 240) return null;
  return { title, dedication };
}

export const atlasRoutes = new Hono();

atlasRoutes.get("/current", async (context) => {
  const { atlas, member } = await requireAtlasAccess(
    context.req.raw,
    "read",
  );
  return context.json({ atlas, role: member.role });
});

atlasRoutes.post("/bootstrap", async (context) => {
  const membership = await requireOrganizationMembership(
    context.req.raw,
    "bootstrap",
  );
  const existing = await db
    .select()
    .from(atlases)
    .where(eq(atlases.organizationId, membership.organizationId))
    .limit(1);

  if (existing[0]) {
    return context.json({ atlas: existing[0], created: false });
  }

  const body = await context.req.json<{
    title?: unknown;
    dedication?: unknown;
  }>();
  const details = parseAtlasDetails(body);
  if (!details) {
    return context.json(
      { error: "INVALID_ATLAS", message: "Invalid atlas title or dedication" },
      400,
    );
  }

  const [atlas] = await db
    .insert(atlases)
    .values({
      organizationId: membership.organizationId,
      ...details,
    })
    .onConflictDoNothing({ target: atlases.organizationId })
    .returning();

  if (atlas) return context.json({ atlas, created: true }, 201);

  const [concurrentAtlas] = await db
    .select()
    .from(atlases)
    .where(eq(atlases.organizationId, membership.organizationId))
    .limit(1);
  return context.json({ atlas: concurrentAtlas, created: false });
});

atlasRoutes.patch("/current", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const details = parseAtlasDetails(await context.req.json());
  if (!details) {
    return context.json(
      { error: "INVALID_ATLAS", message: "Invalid atlas title or dedication" },
      400,
    );
  }
  const [updated] = await db
    .update(atlases)
    .set({ ...details, updatedAt: new Date() })
    .where(eq(atlases.id, atlas.id))
    .returning();
  return context.json({ atlas: updated });
});

atlasRoutes.delete("/current", async (context) => {
  const membership = await requireOrganizationMembership(
    context.req.raw,
    "delete",
  );
  const deleted = await deleteAtlasForOrganization(membership.organizationId);
  if (!deleted) return context.json({ error: "ATLAS_NOT_FOUND" }, 404);
  return context.body(null, 204);
});
