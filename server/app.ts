import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import { auth } from "./auth";
import { AtlasAccessError } from "./authorization/atlas-access";
import { ShareAccessError } from "./authorization/share-access";
import { CoverRevealWorkerAccessError } from "./cover-reveal/worker-credential";
import { db } from "./db/client";
import {
  LocationSearchInvalidError,
  LocationSearchUnavailableError,
} from "./location/location-search";
import {
  ItineraryImportStageError,
  itineraryImportStageFailure,
} from "./itinerary/itinerary-recognition";
import { HomeBasePeriodConflictError } from "./repositories/home-base-repository";
import { requestLog } from "./request-log";
import { accountEmailChangeRoutes } from "./routes/account-email-change";
import { accountIdentityRoutes } from "./routes/account-identities";
import { accountPasswordRoutes } from "./routes/account-password";
import { accountPreferenceRoutes } from "./routes/account-preferences";
import { atlasRoutes } from "./routes/atlases";
import {
  coverRevealRoutes,
  coverRevealWorkerRoutes,
} from "./routes/cover-reveal";
import {
  everydayFragmentRoutes,
  EverydayFragmentInvalidError,
} from "./routes/everyday-fragments";
import { homeBaseRoutes } from "./routes/home-bases";
import { itineraryImportRoutes } from "./routes/itinerary-import";
import { journeyRecordedTrackRoutes } from "./routes/journey-recorded-tracks";
import { journeyRoutes } from "./routes/journeys";
import { locationRoutes } from "./routes/locations";
import { mapStyleRoutes } from "./routes/mapstyle";
import { mediaEvidenceRoutes } from "./routes/media-evidence";
import { shareRoutes, sharedRoutes } from "./routes/shares";
import { uploadRoutes } from "./routes/uploads";
import { StorageUnavailableError } from "./storage/multipart-storage";

export const app = new Hono();

app.use("*", requestLog);

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (context) => context.json({ error: "REQUEST_TOO_LARGE" }, 413),
  }),
);

app.get("/api/health", async (context) => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return context.json(
      { status: "unavailable", database: "unreachable" },
      503,
    );
  }
  return context.json({ status: "ok" });
});

// #345: password verification is a server-internal primitive for the
// account-identity reverification flow, not a public Better Auth capability.
// If the native endpoint were reachable through the wildcard handler, a stolen
// valid session could probe passwords outside the dedicated stable
// user/session/address budget enforced by `/api/account-identities/reverify/password`.
// Keep the internal `auth.api.verifyPassword()` call available while refusing
// every external HTTP method before the Better Auth wildcard can see it.
app.all("/api/auth/verify-password", (context) =>
  context.json({ error: "Not found" }, 404),
);

app.on(["GET", "POST"], "/api/auth/*", (context) =>
  auth.handler(context.req.raw),
);

app.route("/api/account-identities/email-change", accountEmailChangeRoutes);
// #410: password replacement for an account that already has a usable
// credential. Mounted before the generic identity router for the same reason
// email-change is: the more specific prefix has to win.
app.route("/api/account-identities/password", accountPasswordRoutes);
app.route("/api/account-identities", accountIdentityRoutes);
// #387: the account-scoped Earth experience preference. The only route
// module here that derives nothing from an Atlas: the stable user behind the
// session owns the value, so there is no atlasId in the path and none is read
// from the body.
app.route("/api/account-preferences", accountPreferenceRoutes);
app.route("/api/atlases", atlasRoutes);
// #368: the owner's enqueue verb and the machine worker's protocol, mounted
// apart so no route can serve both an Atlas member and a worker credential.
app.route("/api/cover-reveal", coverRevealRoutes);
app.route("/api/cover-reveal-worker", coverRevealWorkerRoutes);
// #231: Home Base periods. A dedicated HTTP surface, but the Atlas is still
// derived from the session inside the route module, never from the path or
// the body.
app.route("/api/home-bases", homeBaseRoutes);
// #234: Everyday Fragments. A separate content type with its own list, so the
// Journey surface stays Journey-only; the Atlas is still derived from the
// session inside the route module, never from the path or the body.
app.route("/api/everyday-fragments", everydayFragmentRoutes);
// #512: reading an itinerary a member already holds into a reviewable draft.
// It writes nothing: the draft is saved through the Journey routes above,
// under the same authorization and the same revision guard as a hand-built
// Route.
app.route("/api/itinerary-import", itineraryImportRoutes);
app.route("/api/journeys", journeyRoutes);
// #419: owner-only recorded-track evidence for one Journey, and since #341
// the format-neutral import channel that writes it. Never part of a guest
// share payload, because these samples are precise.
app.route("/api/journey-recorded-tracks", journeyRecordedTrackRoutes);
app.route("/api/locations", locationRoutes);
app.route("/api/mapstyle", mapStyleRoutes);
// #388: owner-only durable spatial/time evidence for one existing media asset.
// Guest/share paths stay separate and never mount this mutation/read surface.
app.route("/api/media-evidence", mediaEvidenceRoutes);
// #200: owner-authorized share management, and the guest capability path kept
// deliberately separate so no route can serve both an Atlas member and a
// bearer token.
app.route("/api/shares", shareRoutes);
app.route("/api/shared", sharedRoutes);
app.route("/api/uploads", uploadRoutes);

app.notFound((context) =>
  context.json({ error: "Not found" }, 404),
);

app.onError((error, context) => {
  if (error instanceof AtlasAccessError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status,
    );
  }
  // #368: a worker request that authorizes nothing. One code and one fixed
  // message for every cause, so a probe cannot tell an unset credential from a
  // wrong one, and so nothing about the presented credential reaches the log
  // line below.
  if (error instanceof CoverRevealWorkerAccessError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status,
    );
  }
  if (error instanceof ShareAccessError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status,
    );
  }
  // #231: an impossible Home Base history — end before start, an overlap, or
  // a second current Home. All three are refusals about recorded state rather
  // than about the request document, so they share one 409 envelope carrying
  // the specific code.
  if (error instanceof HomeBasePeriodConflictError) {
    return context.json(
      { error: error.code, message: error.message },
      409,
    );
  }
  // #234: an unusable Everyday Fragment document. The reason code the pure
  // validator produced travels as `error`, so the refusal names the field that
  // is wrong instead of the route composing its own JSON shape.
  if (error instanceof EverydayFragmentInvalidError) {
    return context.json(
      { error: error.code, message: error.message },
      400,
    );
  }
  // #512: an import refusal always says which of the three stages it happened
  // in. A deployment that cannot reach a page, one that cannot yet render it
  // and a reading that failed are different problems, and the client shows
  // each of them as itself instead of as "the link is invalid".
  if (error instanceof ItineraryImportStageError) {
    const failure = itineraryImportStageFailure(error);
    return context.json(failure.body, failure.status as 400);
  }
  if (error instanceof StorageUnavailableError) {
    return context.json(
      { error: "STORAGE_UNAVAILABLE", message: error.message },
      503,
    );
  }
  // #539: unusable search parameters, such as a half-given search focus.
  if (error instanceof LocationSearchInvalidError) {
    return context.json(
      { error: error.code, message: error.message },
      400,
    );
  }
  if (error instanceof LocationSearchUnavailableError) {
    return context.json(
      { error: "LOCATION_SEARCH_UNAVAILABLE", message: error.message },
      503,
    );
  }
  // The backstop, not the normal path. Every route module that reads a JSON
  // body answers a malformed one with its own 400 through `readJsonObject`
  // (or `readShareInput`), so a client cannot tell a malformed body from a
  // non-object or an invalid one. What still arrives here is the Better Auth
  // handler mounted at `/api/auth/*`, whose bodies this app never parses, and
  // any future route added without that guard.
  if (error instanceof SyntaxError) {
    return context.json(
      { error: "INVALID_JSON", message: "Request body is not valid JSON" },
      400,
    );
  }
  console.error("API request failed", error.message);
  return context.json({ error: "Internal server error" }, 500);
});
