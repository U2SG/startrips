import { Hono, type Context } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  createEverydayFragmentForAtlas,
  deleteEverydayFragmentForAtlas,
  listEverydayFragmentsForAtlas,
  updateEverydayFragmentForAtlas,
  type EverydayFragmentWriteResult,
} from "../repositories/everyday-fragment-repository";
import {
  validateEverydayFragmentInput,
  type EverydayFragmentReasonCode,
  type EverydayFragmentValues,
} from "../../src/journey/everydayFragment";
import { readJsonObject } from "./json-body";

/**
 * #234: the member-authorized Everyday Fragment surface.
 *
 * A dedicated HTTP surface, Atlas-owned domain data underneath. The Atlas
 * comes only from `requireAtlasAccess`, i.e. from the authenticated session's
 * active Organization, so there is no `/api/atlases/:atlasId/...` path and an
 * `atlasId` or `organizationId` in a request body is read by nothing here —
 * the parser accepts six named fields and no others.
 *
 * `GET /api/journeys` stays Journey-only. Fragments are a separate content
 * type with a separate list, which is exactly what keeps the Journey list from
 * filling with ordinary Tuesdays.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EVERYDAY_FRAGMENT_CACHE_CONTROL = "private, no-store, max-age=0";

const REASON_MESSAGES: Record<
  EverydayFragmentReasonCode | "INVALID_EVERYDAY_FRAGMENT",
  string
> = {
  INVALID_EVERYDAY_FRAGMENT: "Request body is not a usable fragment document",
  EVERYDAY_FRAGMENT_INVALID_DATE:
    "An Everyday Fragment needs the calendar date it happened on",
  EVERYDAY_FRAGMENT_INVALID_LATITUDE:
    "Latitude must be a number between -90 and 90",
  EVERYDAY_FRAGMENT_INVALID_LONGITUDE:
    "Longitude must be a number between -180 and 180",
  EVERYDAY_FRAGMENT_INVALID_TEXT: "A place label and a note must be text",
  EVERYDAY_FRAGMENT_TEXT_TOO_LONG: "That place label or note is too long",
  EVERYDAY_FRAGMENT_INVALID_HOME_BASE_PERIOD:
    "That Home Base period reference is not an identifier",
};

/**
 * An unusable fragment document, refused with the reason code the pure
 * validator produced.
 *
 * Thrown rather than answered inline so `server/app.ts` `onError` owns the
 * `{ error, message }` envelope for this class of failure, the way it already
 * does for `AtlasAccessError` and `HomeBasePeriodConflictError`. The reason
 * code travels as `error`, so a client learns which field is wrong from the
 * code instead of by parsing prose, and no route here composes its own JSON
 * shape that could drift from the rest of the API.
 */
export class EverydayFragmentInvalidError extends Error {
  constructor(readonly code: EverydayFragmentReasonCode | "INVALID_EVERYDAY_FRAGMENT") {
    super(REASON_MESSAGES[code]);
    this.name = "EverydayFragmentInvalidError";
  }
}

/**
 * Reads the document and refuses it with a reason code. The validation itself
 * lives in `src/journey/everydayFragment.ts`, so the rule a test pins and the
 * rule the API enforces are the same function rather than two copies.
 */
async function readFragmentValues(
  read: () => Promise<unknown>,
): Promise<EverydayFragmentValues> {
  const body = await readJsonObject(read);
  if (!body) throw new EverydayFragmentInvalidError("INVALID_EVERYDAY_FRAGMENT");
  const validation = validateEverydayFragmentInput(body);
  if (!validation.accepted) {
    throw new EverydayFragmentInvalidError(validation.reason);
  }
  return validation.values;
}

/**
 * The write outcomes that are not a saved fragment. Each is a 404 that
 * discloses nothing: an Atlas being deleted, a fragment another Atlas owns and
 * a Home Base period another Atlas owns are all answered as "not found"
 * without confirming that the id exists somewhere else.
 */
function answerWriteResult(
  context: Context,
  result: EverydayFragmentWriteResult,
  createdStatus: 200 | 201,
) {
  if (result.outcome === "atlas-missing") {
    return context.json({ error: "ATLAS_NOT_FOUND" }, 404);
  }
  if (result.outcome === "fragment-missing") {
    return context.json({ error: "EVERYDAY_FRAGMENT_NOT_FOUND" }, 404);
  }
  if (result.outcome === "home-base-missing") {
    return context.json({ error: "HOME_BASE_PERIOD_NOT_FOUND" }, 404);
  }
  // A period this Atlas does own, which simply did not hold on the day the
  // fragment happened. That is a statement about the recorded timeline, not
  // about the document's syntax, so it leaves as the 409 `home-bases.ts`
  // answers an impossible history with rather than as a 400.
  if (result.outcome === "home-base-not-covering") {
    return context.json(
      {
        error: "EVERYDAY_FRAGMENT_HOME_BASE_MISMATCH",
        message:
          "That Home Base period does not cover the date this fragment happened on",
      },
      409,
    );
  }
  context.header("Cache-Control", EVERYDAY_FRAGMENT_CACHE_CONTROL);
  return context.json({ fragment: result.fragment }, createdStatus);
}

export const everydayFragmentRoutes = new Hono();

everydayFragmentRoutes.get("/", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", EVERYDAY_FRAGMENT_CACHE_CONTROL);
  return context.json({
    fragments: await listEverydayFragmentsForAtlas(atlas.id),
  });
});

everydayFragmentRoutes.post("/", async (context) => {
  const { atlas, session } = await requireAtlasAccess(context.req.raw, "create");
  const values = await readFragmentValues(() => context.req.json());
  const result = await createEverydayFragmentForAtlas(
    atlas.id,
    session.user.id,
    values,
  );
  return answerWriteResult(context, result, 201);
});

everydayFragmentRoutes.put("/:fragmentId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const fragmentId = context.req.param("fragmentId");
  // A malformed id is answered like an unknown one: a fragment this Atlas does
  // not own is never distinguishable from one that does not exist. Checked
  // before the body, so an unknown target answers 404 whether or not the
  // document that accompanied it was valid.
  if (!UUID_PATTERN.test(fragmentId)) {
    return context.json({ error: "EVERYDAY_FRAGMENT_NOT_FOUND" }, 404);
  }
  const values = await readFragmentValues(() => context.req.json());
  const result = await updateEverydayFragmentForAtlas(
    atlas.id,
    fragmentId,
    values,
  );
  return answerWriteResult(context, result, 200);
});

/**
 * `update`, not `delete`, for the same reason `home-bases.ts` and `shares.ts`
 * use it: `delete` is owner-only in `permissions.ts`, and a member who can
 * record an ordinary evening must be able to withdraw one they recorded by
 * mistake. Removing a fragment deletes that fragment and its own media and
 * touches no Journey, so it is not destructive in the sense that action name
 * reserves.
 */
everydayFragmentRoutes.delete("/:fragmentId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const fragmentId = context.req.param("fragmentId");
  if (!UUID_PATTERN.test(fragmentId)) {
    return context.json({ error: "EVERYDAY_FRAGMENT_NOT_FOUND" }, 404);
  }
  const deleted = await deleteEverydayFragmentForAtlas(atlas.id, fragmentId);
  if (!deleted) {
    return context.json({ error: "EVERYDAY_FRAGMENT_NOT_FOUND" }, 404);
  }
  return context.body(null, 204);
});
