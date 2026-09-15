import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { requireCoverRevealWorker } from "../cover-reveal/worker-credential";
import {
  claimCoverRevealJob,
  completeCoverRevealJob,
  enqueueCoverRevealDerivative,
  failCoverRevealJob,
  signCoverRevealOutputUpload,
  signCoverRevealSourceRead,
  type CoverRevealSettings,
} from "../services/cover-reveal";
import { readJsonObject } from "./json-body";

/**
 * #368 (Slice 1 of #367): the cover-reveal worker protocol's HTTP surface.
 *
 * Two routers, mounted separately, exactly like `shareRoutes` and
 * `sharedRoutes`: no single route may ever serve both an Atlas member and a
 * machine credential. `coverRevealRoutes` is the owner's — a session, an
 * Atlas, and one verb: ask the server whether this Journey's cover can have a
 * derivative and queue it if so. `coverRevealWorkerRoutes` is the worker's,
 * and every handler in it is behind `requireCoverRevealWorker` plus a lease
 * token that names one claim of one job.
 *
 * Nothing in either router accepts a storage key, a media asset id or a
 * Journey id from a worker. The owner names a Journey it already owns; the
 * worker names only a job it holds the lease for, and every object it touches
 * is one the server chose.
 */
export const coverRevealRoutes = new Hono();
export const coverRevealWorkerRoutes = new Hono();

/**
 * A claim response carries a bearer lease token and, on the capability routes,
 * a signed URL. Neither may ever sit in a shared cache.
 */
export const COVER_REVEAL_CACHE_CONTROL = "private, no-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The worker's own vocabulary for why an attempt produced nothing.
 *
 * An allowlist rather than a message, because `last_error_code` is persisted
 * and a free-text field written by an external process is the easiest place
 * for a signed URL or a credential to end up in a database and then in a log.
 * Anything outside the list is recorded as the generic code.
 */
export const COVER_REVEAL_WORKER_FAILURE_CODES = [
  "WORKER_SOURCE_UNREADABLE",
  "WORKER_GENERATION_FAILED",
  "WORKER_UPLOAD_FAILED",
  "WORKER_CANCELLED",
] as const;

export function normalizeWorkerFailureCode(value: unknown): string {
  return typeof value === "string"
    && (COVER_REVEAL_WORKER_FAILURE_CODES as readonly string[]).includes(value)
    ? value
    : "WORKER_UNSPECIFIED";
}

export function coverRevealSettings(): CoverRevealSettings {
  return {
    leaseSeconds: serverConfig.coverRevealLeaseSeconds,
    sourceReadExpiresInSeconds:
      serverConfig.coverRevealSourceReadExpiresInSeconds,
    uploadExpiresInSeconds: serverConfig.coverRevealUploadExpiresInSeconds,
    maxBytes: serverConfig.coverRevealMaxBytes,
    maxEdgePixels: serverConfig.coverRevealMaxEdgePixels,
    maxAttempts: serverConfig.coverRevealMaxAttempts,
  };
}

/**
 * The lease token of the claim this request belongs to.
 *
 * It travels in the body rather than in `Authorization`, because that header
 * already carries the worker credential and the two are different things: the
 * credential says which process may speak here at all, the lease says which
 * claim of which job it is speaking as. Keeping them apart is also what lets
 * the credential be rotated without invalidating an in-flight generation.
 */
async function readLeaseToken(read: () => Promise<unknown>) {
  const body = await readJsonObject(read);
  const leaseToken = body?.leaseToken;
  return {
    leaseToken: typeof leaseToken === "string" && leaseToken.length > 0
      ? leaseToken
      : null,
    body,
  };
}

// The owner's single verb. Eligibility is decided here from canonical Journey
// state and never from anything the caller said beyond which Journey it is.
coverRevealRoutes.post("/journeys/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const journeyId = context.req.param("id");
  if (!UUID_PATTERN.test(journeyId)) {
    return context.json({ error: "JOURNEY_UNAVAILABLE" }, 404);
  }
  const result = await enqueueCoverRevealDerivative(journeyId, atlas.id);
  if (!result.ok) return context.json({ error: result.error }, result.status);
  return context.json({ derivative: result.job });
});

coverRevealWorkerRoutes.use("*", async (context, next) => {
  requireCoverRevealWorker(
    context.req.raw,
    serverConfig.coverRevealWorkerToken,
  );
  context.header("cache-control", COVER_REVEAL_CACHE_CONTROL);
  await next();
});

/** Step 1: take at most one job, with a bounded lease. */
coverRevealWorkerRoutes.post("/claim", async (context) => {
  const result = await claimCoverRevealJob(coverRevealSettings());
  if (!result.ok) return context.json({ error: result.error }, result.status);
  return context.json({
    derivative: result.job,
    lease: {
      token: result.leaseToken,
      expiresAt: result.leaseExpiresAt.toISOString(),
    },
    output: {
      mimeType: "image/jpeg",
      maxBytes: serverConfig.coverRevealMaxBytes,
      maxEdgePixels: serverConfig.coverRevealMaxEdgePixels,
    },
  });
});

/** Step 2: a short-lived read of exactly the pinned source. */
coverRevealWorkerRoutes.post("/jobs/:id/source-read", async (context) => {
  const { leaseToken } = await readLeaseToken(() => context.req.json());
  if (!leaseToken) return context.json({ error: "INVALID_LEASE" }, 400);
  const result = await signCoverRevealSourceRead(
    context.req.param("id"),
    leaseToken,
    coverRevealSettings(),
  );
  if (!result.ok) return context.json({ error: result.error }, result.status);
  return context.json({
    source: {
      url: result.url,
      expiresAt: result.expiresAt.toISOString(),
      mimeType: result.mimeType,
      bytes: result.bytes,
    },
  });
});

/** Step 3: a write for exactly the object this claim owns. */
coverRevealWorkerRoutes.post("/jobs/:id/output-upload", async (context) => {
  const { leaseToken } = await readLeaseToken(() => context.req.json());
  if (!leaseToken) return context.json({ error: "INVALID_LEASE" }, 400);
  const result = await signCoverRevealOutputUpload(
    context.req.param("id"),
    leaseToken,
    coverRevealSettings(),
  );
  if (!result.ok) return context.json({ error: result.error }, result.status);
  return context.json({
    upload: {
      url: result.url,
      headers: result.headers,
      expiresAt: result.expiresAt.toISOString(),
      mimeType: result.mimeType,
      maxBytes: result.maxBytes,
      maxEdgePixels: result.maxEdgePixels,
    },
  });
});

/** Step 4a: publish what was written, after the server has measured it. */
coverRevealWorkerRoutes.post("/jobs/:id/complete", async (context) => {
  const { leaseToken } = await readLeaseToken(() => context.req.json());
  if (!leaseToken) return context.json({ error: "INVALID_LEASE" }, 400);
  const result = await completeCoverRevealJob(
    context.req.param("id"),
    leaseToken,
    coverRevealSettings(),
  );
  if (!result.ok) return context.json({ error: result.error }, result.status);
  return context.json({ derivative: result.job });
});

/** Step 4b: report that this attempt produced nothing. */
coverRevealWorkerRoutes.post("/jobs/:id/fail", async (context) => {
  const { leaseToken, body } = await readLeaseToken(() => context.req.json());
  if (!leaseToken) return context.json({ error: "INVALID_LEASE" }, 400);
  const result = await failCoverRevealJob(
    context.req.param("id"),
    leaseToken,
    normalizeWorkerFailureCode(body?.reason),
    coverRevealSettings(),
  );
  if (!result.ok) return context.json({ error: result.error }, result.status);
  return context.json({ derivative: result.job });
});
