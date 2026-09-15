import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * #368: the machine credential class, which Startrips did not have.
 *
 * Every capability in the product before this one is either a user session
 * (`requireAtlasAccess`, derived from `session.session.activeOrganizationId`)
 * or a share grant (`requireActiveShareGrant`, a hashed bearer over an
 * explicit read-only Journey set). A cover-reveal worker is neither: it is an
 * external process that must be able to claim ONE queued job and nothing else
 * — no Journey read, no media enumeration, no Atlas, no share, no database and
 * no object-store credential.
 *
 * So the credential is not a token this module can mint into a session. It
 * authorizes exactly the routes in `server/routes/cover-reveal.ts` that are
 * mounted behind `requireCoverRevealWorker`, and every route in the rest of
 * the API resolves its principal the way it always did, which is why
 * presenting this credential anywhere else answers exactly as presenting
 * nothing would.
 *
 * Revocation and rotation are the deployment's: the credential is one env
 * value read by `server/config.ts`, so changing or removing it takes effect on
 * the next start and needs no row to be found or invalidated.
 */

/** The same 256-bit floor the share token uses; a slow KDF would add nothing. */
export const COVER_REVEAL_WORKER_TOKEN_BYTES = 32;
export const MIN_COVER_REVEAL_WORKER_TOKEN_LENGTH = 32;

/**
 * A worker request that authorizes nothing right now.
 *
 * One status and one message for every cause — no credential, a wrong
 * credential, and a deployment with the credential unset all look identical
 * from outside, so probing learns nothing beyond "unavailable". `message` is a
 * fixed string because `app.ts` logs `error.message`, and the one thing that
 * must never reach a log here is any part of the presented credential.
 */
export class CoverRevealWorkerAccessError extends Error {
  constructor(
    readonly status: 401,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function coverRevealWorkerUnauthorized(): CoverRevealWorkerAccessError {
  return new CoverRevealWorkerAccessError(
    401,
    "COVER_REVEAL_WORKER_UNAUTHORIZED",
    "Cover-reveal worker credential required",
  );
}

export function generateCoverRevealWorkerToken(): string {
  return randomBytes(COVER_REVEAL_WORKER_TOKEN_BYTES).toString("base64url");
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare over fixed-width digests rather than over the raw strings, so
 * neither the length nor any prefix of the configured credential is
 * observable in the time the comparison takes.
 */
export function matchesCoverRevealWorkerToken(
  presented: string,
  configured: string,
) {
  return timingSafeEqual(sha256(presented), sha256(configured));
}

export function parseWorkerBearerToken(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue) return null;
  const match = /^Bearer +(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

/**
 * Authorize one worker request, or refuse it.
 *
 * Fail-closed on an unset credential: a deployment that has not configured a
 * worker refuses every worker route, which is the same shape as
 * `STORAGE_DRIVER=disabled` degrading truthfully rather than pretending. The
 * rest of the API is untouched, because nothing else consults this.
 */
export function requireCoverRevealWorker(
  request: Request,
  configuredToken: string | null,
) {
  const presented = parseWorkerBearerToken(request.headers.get("authorization"));
  if (!configuredToken || !presented) throw coverRevealWorkerUnauthorized();
  if (!matchesCoverRevealWorkerToken(presented, configuredToken)) {
    throw coverRevealWorkerUnauthorized();
  }
}

/**
 * A lease token: the proof that a specific claim, not merely a worker, owns a
 * job right now.
 *
 * Separate from the credential on purpose. The credential says which process
 * may talk to these routes at all; the lease says which claim of which job the
 * caller is. Only the SHA-256 is stored, so a database reader — a backup, a
 * log of a query, an operator — cannot complete a job it did not claim.
 */
export function generateCoverRevealLeaseToken(): string {
  return randomBytes(COVER_REVEAL_WORKER_TOKEN_BYTES).toString("base64url");
}

export function hashCoverRevealLeaseToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}
