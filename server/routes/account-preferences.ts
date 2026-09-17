import { Hono, type Context } from "hono";
import { auth } from "../auth";
import {
  readEarthExperiencePreferenceForUser,
  writeEarthExperiencePreferenceForUser,
  type EarthExperiencePreferenceRecord,
} from "../repositories/account-preference-repository";
import {
  EARTH_EXPERIENCE_PREFERENCES,
  isEarthExperiencePreference,
} from "../../src/journey/earthExperiencePreference";
import { readJsonObject } from "./json-body";

/**
 * #387: the account-scoped preference surface.
 *
 * Unlike every other route module here, this one does NOT call
 * `requireAtlasAccess`. A preference belongs to a person, not to an Atlas, so
 * the only thing it needs is the stable user behind the session — and it reads
 * that user id only from the resolved session, never from a path segment, a
 * query parameter or the body. There is no `/api/account-preferences/:userId`
 * and no `userId` field is accepted, so cross-user access has no expression in
 * this API rather than being a check that could be forgotten.
 *
 * That also settles the share case without a share-specific branch. A guest
 * holds a share token and is served by `sharedRoutes`; a token is not a
 * session, so `auth.api.getSession` resolves nothing here and the guest is
 * answered 401. A signed-in person who happens to hold a grant on somebody
 * else's Atlas resolves to their OWN user, so they read their own preference —
 * holding a grant conveys nothing about the sharer's account.
 */

/**
 * `private` keeps a shared cache from ever storing one person's answer, and
 * `no-store` keeps the browser from replaying account A's response after a
 * logout and a sign-in as account B. The same header the Home Base and
 * Everyday Fragment surfaces use, for the same reason.
 */
export const ACCOUNT_PREFERENCE_CACHE_CONTROL = "private, no-store, max-age=0";

function answer(context: Context, record: EarthExperiencePreferenceRecord) {
  context.header("Cache-Control", ACCOUNT_PREFERENCE_CACHE_CONTROL);
  return context.json({
    earthExperience: record.earthExperience,
    // Version truth, so a client can drop a response that lost a race instead
    // of letting a slow in-flight read overwrite a newer local choice.
    // `revision` counts value transitions: a same-value write returns the
    // revision unchanged, which is the honest answer, not a stale one.
    revision: record.revision,
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
  });
}

export const accountPreferenceRoutes = new Hono();

accountPreferenceRoutes.get("/earth-experience", async (context) => {
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
  return answer(
    context,
    await readEarthExperiencePreferenceForUser(session.user.id),
  );
});

accountPreferenceRoutes.put("/earth-experience", async (context) => {
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
  // Captured once, from the session resolved for THIS request. Everything
  // below writes against this id, so a session that is replaced or signed out
  // while the write is in flight cannot redirect the write onto another
  // person's row.
  const userId = session.user.id;
  const body = await readJsonObject(() => context.req.json());
  const earthExperience = body?.earthExperience;
  if (!isEarthExperiencePreference(earthExperience)) {
    return context.json(
      {
        error: "INVALID_EARTH_EXPERIENCE",
        message: `Earth experience must be one of ${EARTH_EXPERIENCE_PREFERENCES.join(", ")}`,
      },
      400,
    );
  }
  return answer(
    context,
    await writeEarthExperiencePreferenceForUser(userId, earthExperience),
  );
});
