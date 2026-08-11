import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  requireAtlasAccess,
  requireOrganizationMembership,
} from "../authorization/atlas-access";
import { db } from "../db/client";
import { atlases } from "../db/app-schema";

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
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const dedication =
    typeof body.dedication === "string" ? body.dedication.trim() : "";
  if (!title || title.length > 80 || dedication.length > 240) {
    return context.json(
      { error: "INVALID_ATLAS", message: "Invalid atlas title or dedication" },
      400,
    );
  }

  const [atlas] = await db
    .insert(atlases)
    .values({
      organizationId: membership.organizationId,
      title,
      dedication,
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
