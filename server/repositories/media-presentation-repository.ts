import { eq, sql } from "drizzle-orm";
import { accountMediaPresentations } from "../db/app-schema";
import { db } from "../db/client";
import { parseMediaPresentationStyle, type MediaPresentationStyle } from "../../src/journey/mediaPresentationStyle";

export async function readMediaPresentationForUser(userId: string): Promise<MediaPresentationStyle> {
  const [row] = await db.select({ style: accountMediaPresentations.style })
    .from(accountMediaPresentations).where(eq(accountMediaPresentations.userId, userId));
  return parseMediaPresentationStyle(row?.style);
}

export async function writeMediaPresentationForUser(userId: string, style: MediaPresentationStyle): Promise<MediaPresentationStyle> {
  const [row] = await db.insert(accountMediaPresentations).values({ userId, style })
    .onConflictDoUpdate({
      target: accountMediaPresentations.userId,
      set: {
        style: sql`excluded.style`,
        updatedAt: sql`case when ${accountMediaPresentations.style} is distinct from excluded.style then now() else ${accountMediaPresentations.updatedAt} end`,
      },
    }).returning({ style: accountMediaPresentations.style });
  return parseMediaPresentationStyle(row!.style);
}
