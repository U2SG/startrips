import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  coverRevealDerivatives,
  coverRevealWrites,
  journeys,
  mediaAssets,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  createJourneyForAtlas,
  markJourneyForDeletionForAtlas,
} from "../repositories/journey-repository";
import {
  claimCoverRevealJob,
  completeCoverRevealJob,
  COVER_REVEAL_KEY_PREFIX,
  COVER_REVEAL_OUTPUT_MIME_TYPE,
  enqueueCoverRevealDerivative,
  failCoverRevealJob,
  reconcileCoverRevealDerivatives,
  reconcileCoverRevealNamespace,
  reconcileCoverRevealWrites,
  signCoverRevealOutputUpload,
  signCoverRevealSourceRead,
  type CoverRevealDependencies,
  type CoverRevealSettings,
} from "../services/cover-reveal";
import { disabledStorage } from "../storage/disabled-storage";
import type { MultipartStorage } from "../storage/multipart-storage";

const TEST_ORIGIN = "http://127.0.0.1:5173";

/**
 * A real 600x467 JPEG, so every "the server measured the object that landed"
 * assertion is made against bytes rather than against a stub that answered a
 * number. `oversized-still-2048x1024.jpg` fails the pixel ceiling on its own.
 */
const GENERATED_DERIVATIVE = new Uint8Array(readFileSync(
  new URL("./fixtures/derived-preview-600x467.jpg", import.meta.url),
));
const OVERSIZED_DERIVATIVE = new Uint8Array(readFileSync(
  new URL("./fixtures/oversized-still-2048x1024.jpg", import.meta.url),
));

/**
 * Deliberately tight ceilings, so a case can fail one bound at a time with a
 * small real file instead of allocating the shipped 4 MiB budget.
 */
const SETTINGS: CoverRevealSettings = {
  leaseSeconds: 600,
  sourceReadExpiresInSeconds: 300,
  uploadExpiresInSeconds: 600,
  maxBytes: 512 * 1024,
  maxEdgePixels: 1024,
  maxAttempts: 3,
};

/**
 * The credential the worker cases present.
 *
 * `serverConfig` is read once at import, so the configured value is set on the
 * live object for the duration of this file and restored afterwards. That is
 * the only way to exercise both the configured and the unset deployment in one
 * process, and it is the real read path: the worker middleware consults
 * `serverConfig.coverRevealWorkerToken` per request.
 */
const WORKER_TOKEN = `worker-${"z".repeat(40)}`;
const mutableConfig = serverConfig as unknown as {
  coverRevealWorkerToken: string | null;
};
const originalWorkerToken = serverConfig.coverRevealWorkerToken;

const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];

const baseJourney = {
  startedOn: "2026-09-11",
  endedOn: "2026-09-12",
  note: "private",
  lightColor: "#f4ce73",
  routePoints: [
    {
      latitude: 1.3521,
      longitude: 103.8198,
      label: "Singapore",
      isStop: true,
      occurredAt: new Date("2026-09-11T00:00:00Z"),
    },
    {
      latitude: 35.6762,
      longitude: 139.6503,
      label: "Tokyo",
      isStop: true,
      occurredAt: new Date("2026-09-12T00:00:00Z"),
    },
  ],
};

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

function workerHeaders(token: string | null = WORKER_TOKEN) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** One verified identity with an Atlas, created the way the product creates one. */
async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  await db.delete(rateLimit);
  const signUp = await app.request(`${TEST_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: label, email, password }),
  });
  expect(signUp.status).toBe(200);

  const verificationToken = await createEmailVerificationToken(
    serverConfig.authSecret,
    email,
  );
  const verification = await app.request(
    `${TEST_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`,
    { headers: authHeaders() },
  );
  expect(verification.status).toBe(200);

  const signIn = await app.request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();
  const { user } = await signIn.json() as { user: { id: string } };

  const organizationResponse = await app.request(
    `${TEST_ORIGIN}/api/auth/organization/create`,
    {
      method: "POST",
      headers: authHeaders(cookie!),
      body: JSON.stringify({
        name: `${label} Atlas`,
        slug: `${label.toLowerCase()}-${randomUUID()}`,
      }),
    },
  );
  expect(organizationResponse.status).toBe(200);
  const organization = await organizationResponse.json() as { id: string };
  authOrganizationIds.push(organization.id);

  const bootstrap = await app.request(`${TEST_ORIGIN}/api/atlases/bootstrap`, {
    method: "POST",
    headers: authHeaders(cookie!),
    body: JSON.stringify({ title: `${label} Atlas`, dedication: "private" }),
  });
  expect([200, 201]).toContain(bootstrap.status);
  const payload = await bootstrap.json() as { atlas: { id: string } };
  atlasIds.push(payload.atlas.id);
  return { cookie: cookie!, userId: user.id, atlasId: payload.atlas.id };
}

/**
 * A storage adapter that records what it was asked to sign, inspect and
 * delete, and holds real bytes.
 *
 * The core lane runs with `STORAGE_DRIVER=disabled`, so this is how the
 * object-facing half of the protocol is exercised at all — and the truthful
 * degradation of the real registry is asserted separately below.
 */
function recordingStorage(generated: Uint8Array | null = GENERATED_DERIVATIVE) {
  const signedReads: Array<{ key: string; expiresInSeconds: number }> = [];
  const signedUploads: Array<{
    key: string;
    mimeType: string;
    expiresInSeconds: number;
  }> = [];
  const deleted: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const storage: MultipartStorage = {
    ...disabledStorage,
    driver: "s3",
    async signObjectUpload(input) {
      signedUploads.push(input);
      // The worker writing to the URL it was just handed, modelled as the one
      // thing a worker does. A case that needs nothing to land passes null.
      if (generated) objects.set(input.key, generated);
      return {
        url: `https://storage.test/put/${encodeURIComponent(input.key)}`,
        headers: { "content-type": input.mimeType },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
    async inspectObject(input) {
      const stored = objects.get(input.key);
      return stored
        ? { exists: true as const, bytes: stored.byteLength }
        : { exists: false as const };
    },
    async readObjectHead(input) {
      const stored = objects.get(input.key);
      return stored
        ? { exists: true as const, bytes: stored.subarray(0, input.maxBytes) }
        : { exists: false as const };
    },
    async listObjects(input) {
      return {
        keys: [...objects.keys()].filter((key) => key.startsWith(input.prefix)),
      };
    },
    async deleteObject(input) {
      deleted.push(input.key);
      objects.delete(input.key);
    },
    async createPrivateReadUrl(input) {
      signedReads.push(input);
      return {
        url: `https://storage.test/read/${encodeURIComponent(input.key)}`,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
  };
  const dependencies: CoverRevealDependencies = {
    storageForBackend: () => storage,
    configuredStorage: () => storage,
  };
  return { signedReads, signedUploads, deleted, objects, dependencies };
}

describe("#368 cover-reveal worker protocol", () => {
  let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;

  beforeAll(async () => {
    mutableConfig.coverRevealWorkerToken = WORKER_TOKEN;
    identity = await createAuthenticatedAtlas("coverreveal");
  });

  /**
   * The claim is a QUEUE: it takes the oldest claimable job in the whole
   * table, not the one this case just enqueued. A case that left a job
   * retryable would therefore be claimed by the next case instead of its own
   * work, so each case starts from an empty queue. Nothing else in the suite
   * writes these two tables.
   */
  beforeEach(async () => {
    await db.delete(coverRevealDerivatives);
    await db.delete(coverRevealWrites);
  });

  afterAll(async () => {
    mutableConfig.coverRevealWorkerToken = originalWorkerToken;
    if (atlasIds.length > 0) {
      await db.delete(atlases).where(inArray(atlases.id, atlasIds));
    }
    if (authOrganizationIds.length > 0) {
      await db
        .delete(authOrganizations)
        .where(inArray(authOrganizations.id, authOrganizationIds));
    }
    if (authUserEmails.length > 0) {
      await db
        .delete(authUsers)
        .where(inArray(authUsers.email, authUserEmails));
    }
    await pool.end();
  });

  /**
   * A Journey with one verified image cover, written straight in: without a
   * storage driver there is no reachable upload path, and every case here is
   * about the job rather than about multipart mechanics.
   */
  async function createJourneyWithCover(options: {
    contentHashVerified?: boolean;
    mimeType?: string;
  } = {}) {
    const journey = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, title: `Cover reveal ${randomUUID()}` },
    );
    const journeyId = (journey as { id: string }).id;
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId,
        storageDriver: "s3",
        storageKey: `${identity.atlasId}/${journeyId}/${randomUUID()}`,
        fileName: "cover.jpg",
        mimeType: options.mimeType ?? "image/jpeg",
        bytes: 4_194_304,
        contentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        contentHashVerified: options.contentHashVerified ?? true,
        sortOrder: 0,
        uploadedByUserId: identity.userId,
      })
      .returning();
    return { journeyId, asset };
  }

  async function readJob(jobId: string) {
    const [job] = await db
      .select()
      .from(coverRevealDerivatives)
      .where(eq(coverRevealDerivatives.id, jobId));
    return job;
  }

  /** Enqueue, then claim, so a case starts from a job it owns. */
  async function queuedAndClaimed(
    backend = recordingStorage(),
    settings: CoverRevealSettings = SETTINGS,
  ) {
    const { journeyId, asset } = await createJourneyWithCover();
    const enqueued = await enqueueCoverRevealDerivative(
      journeyId,
      identity.atlasId,
      backend.dependencies,
    );
    expect(enqueued.ok).toBe(true);
    const claim = await claimCoverRevealJob(
      settings,
      new Date(),
      backend.dependencies,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("unreachable");
    return { journeyId, asset, claim, backend, settings };
  }

  describe("worker credential", () => {
    it("refuses every worker route without the credential", async () => {
      for (
        const path of [
          "/api/cover-reveal-worker/claim",
          `/api/cover-reveal-worker/jobs/${randomUUID()}/source-read`,
          `/api/cover-reveal-worker/jobs/${randomUUID()}/output-upload`,
          `/api/cover-reveal-worker/jobs/${randomUUID()}/complete`,
          `/api/cover-reveal-worker/jobs/${randomUUID()}/fail`,
        ]
      ) {
        const anonymous = await app.request(`${TEST_ORIGIN}${path}`, {
          method: "POST",
          headers: workerHeaders(null),
          body: "{}",
        });
        expect(anonymous.status).toBe(401);
        const wrong = await app.request(`${TEST_ORIGIN}${path}`, {
          method: "POST",
          headers: workerHeaders(`${WORKER_TOKEN}-wrong`),
          body: "{}",
        });
        expect(wrong.status).toBe(401);
        expect(await wrong.json()).toEqual({
          error: "COVER_REVEAL_WORKER_UNAUTHORIZED",
          message: "Cover-reveal worker credential required",
        });
      }
    });

    /**
     * The credential is a capability over five routes, not a principal. It
     * cannot read, enumerate or mutate a Journey, Route Point Media, a share
     * or an Atlas, and it is never accepted as a user session.
     */
    it("grants nothing outside the worker routes", async () => {
      const { asset } = await createJourneyWithCover();
      for (
        const [method, path] of [
          ["GET", "/api/journeys"],
          ["POST", "/api/journeys"],
          ["GET", "/api/atlases/current"],
          ["POST", "/api/atlases/bootstrap"],
          ["GET", `/api/uploads/assets/${asset.id}/read-url`],
          ["GET", "/api/shares"],
          ["POST", "/api/shares"],
          ["GET", "/api/home-bases"],
          ["GET", "/api/everyday-fragments"],
          ["POST", "/api/cover-reveal/journeys/00000000-0000-4000-8000-000000000000"],
        ] as const
      ) {
        const response = await app.request(`${TEST_ORIGIN}${path}`, {
          method,
          headers: workerHeaders(),
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(response.status).not.toBe(200);
        expect(response.status).not.toBe(201);
        // Not a session: the Atlas surface answers exactly as it does to an
        // anonymous caller.
        expect([401, 404]).toContain(response.status);
      }
      // The guest capability path resolves a share token, and this is not
      // one. 429 is accepted alongside 404 only because the guest prefix
      // carries its own unknown-token budget; the assertion's point is that
      // this credential never authorizes a guest read.
      const guest = await app.request(
        `${TEST_ORIGIN}/api/shared/journeys`,
        { headers: workerHeaders() },
      );
      expect([404, 429]).toContain(guest.status);
    });

    it("refuses the worker routes when the deployment configures none", async () => {
      mutableConfig.coverRevealWorkerToken = null;
      try {
        const claim = await app.request(
          `${TEST_ORIGIN}/api/cover-reveal-worker/claim`,
          { method: "POST", headers: workerHeaders(), body: "{}" },
        );
        expect(claim.status).toBe(401);
        // And the rest of the API is unaffected by the absence.
        const health = await app.request(`${TEST_ORIGIN}/api/health`);
        expect(health.status).toBe(200);
        const owned = await app.request(`${TEST_ORIGIN}/api/journeys`, {
          headers: authHeaders(identity.cookie),
        });
        expect(owned.status).toBe(200);
      } finally {
        mutableConfig.coverRevealWorkerToken = WORKER_TOKEN;
      }
    });
  });

  describe("eligibility and enqueue", () => {
    it("enqueues from canonical state and is idempotent by pinned identity", async () => {
      const { journeyId, asset } = await createJourneyWithCover();
      const first = await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
      );
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");
      expect(first.job.sourceMediaAssetId).toBe(asset.id);
      expect(first.job.sourceContentHash).toBe(asset.contentHash);
      expect(first.job.state).toBe("queued");

      const second = await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
      );
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      expect(second.job.id).toBe(first.job.id);
    });

    it("refuses a source whose stored-byte identity is unverified", async () => {
      const { journeyId } = await createJourneyWithCover({
        contentHashVerified: false,
      });
      const result = await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
      );
      expect(result).toMatchObject({
        ok: false,
        error: "SOURCE_IDENTITY_UNVERIFIED",
      });
    });

    /**
     * The read-then-insert above is an optimisation; the live-identity partial
     * unique index is the guarantee. Two owners asking together must not leave
     * two claimable jobs for one cover.
     */
    it("leaves one job when two enqueues race for the same cover", async () => {
      const { journeyId } = await createJourneyWithCover();
      const [left, right] = await Promise.all([
        enqueueCoverRevealDerivative(journeyId, identity.atlasId),
        enqueueCoverRevealDerivative(journeyId, identity.atlasId),
      ]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      if (!left.ok || !right.ok) throw new Error("unreachable");
      expect(right.job.id).toBe(left.job.id);
      const rows = await db
        .select()
        .from(coverRevealDerivatives)
        .where(eq(coverRevealDerivatives.journeyId, journeyId));
      expect(rows).toHaveLength(1);
    });

    it("refuses a Journey the caller's Atlas does not own", async () => {
      const other = await createAuthenticatedAtlas("coverrevealother");
      const journey = await createJourneyForAtlas(other.atlasId, other.userId, {
        ...baseJourney,
        title: "Foreign journey",
      });
      const result = await enqueueCoverRevealDerivative(
        (journey as { id: string }).id,
        identity.atlasId,
      );
      expect(result).toMatchObject({ ok: false, error: "JOURNEY_UNAVAILABLE" });
    });
  });

  describe("atomic claim and bounded lease", () => {
    it("gives exactly one active lease to two concurrent claims", async () => {
      const { journeyId } = await createJourneyWithCover();
      const enqueued = await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
      );
      expect(enqueued.ok).toBe(true);
      if (!enqueued.ok) throw new Error("unreachable");

      const [left, right] = await Promise.all([
        claimCoverRevealJob(SETTINGS, new Date(), recordingStorage().dependencies),
        claimCoverRevealJob(SETTINGS, new Date(), recordingStorage().dependencies),
      ]);
      const winners = [left, right].filter((result) => result.ok);
      const losers = [left, right].filter((result) => !result.ok);
      expect(winners).toHaveLength(1);
      // The loser is told there is nothing to do, rather than being handed a
      // second lease on the same row.
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_NO_WORK",
      });

      const winner = winners[0];
      if (!winner.ok) throw new Error("unreachable");
      const row = await readJob(winner.job.id);
      expect(row.state).toBe("leased");
      expect(row.attempts).toBe(1);
      expect(row.leaseExpiresAt).not.toBeNull();
    });

    it("reclaims an expired lease and makes the previous claimant stale", async () => {
      const backend = recordingStorage();
      const { journeyId } = await createJourneyWithCover();
      await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
        backend.dependencies,
      );
      // Claimed far enough in the past that its lease has already closed.
      const stale = await claimCoverRevealJob(
        SETTINGS,
        new Date(Date.now() - (SETTINGS.leaseSeconds + 60) * 1_000),
        backend.dependencies,
      );
      expect(stale.ok).toBe(true);
      if (!stale.ok) throw new Error("unreachable");

      const reclaimed = await claimCoverRevealJob(
        SETTINGS,
        new Date(),
        backend.dependencies,
      );
      expect(reclaimed.ok).toBe(true);
      if (!reclaimed.ok) throw new Error("unreachable");
      expect(reclaimed.job.id).toBe(stale.job.id);
      expect(reclaimed.leaseToken).not.toBe(stale.leaseToken);
      expect(reclaimed.job.attempts).toBe(2);

      // The stale claimant cannot commit, and nothing it says changes the
      // state the current lease owns.
      const late = await completeCoverRevealJob(
        stale.job.id,
        stale.leaseToken,
        SETTINGS,
        backend.dependencies,
      );
      expect(late).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_NOT_CLAIMED",
      });
      const row = await readJob(stale.job.id);
      expect(row.state).toBe("leased");
      expect(row.outputMimeType).toBeNull();
    });

    it("stops claiming a job that has spent its retry budget", async () => {
      const settings = { ...SETTINGS, maxAttempts: 1 };
      const backend = recordingStorage();
      const { journeyId } = await createJourneyWithCover();
      await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
        backend.dependencies,
      );
      const claimed = await claimCoverRevealJob(
        settings,
        new Date(),
        backend.dependencies,
      );
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error("unreachable");
      const failed = await failCoverRevealJob(
        claimed.job.id,
        claimed.leaseToken,
        "WORKER_GENERATION_FAILED",
        settings,
      );
      expect(failed).toMatchObject({ ok: true });
      const row = await readJob(claimed.job.id);
      expect(row.state).toBe("failed");
      expect(row.lastErrorCode).toBe("WORKER_GENERATION_FAILED");
    });

    /**
     * Both sweeps skip a key a derivative still references, so a settled
     * attempt that kept its output key would pin whatever the worker PUT —
     * before or after it reported the failure — in the bucket forever.
     */
    it("unreferences and drops the object of a settled attempt", async () => {
      const backend = recordingStorage();
      const { journeyId } = await createJourneyWithCover();
      await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
        backend.dependencies,
      );
      const claimed = await claimCoverRevealJob(
        { ...SETTINGS, maxAttempts: 1 },
        new Date(),
        backend.dependencies,
      );
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error("unreachable");
      await signCoverRevealOutputUpload(
        claimed.job.id,
        claimed.leaseToken,
        SETTINGS,
        backend.dependencies,
      );
      const withKey = await readJob(claimed.job.id);
      const outputKey = withKey.outputStorageKey as string;
      expect(backend.objects.has(outputKey)).toBe(true);

      await failCoverRevealJob(
        claimed.job.id,
        claimed.leaseToken,
        "WORKER_UPLOAD_FAILED",
        { ...SETTINGS, maxAttempts: 1 },
        backend.dependencies,
      );
      const settled = await readJob(claimed.job.id);
      expect(settled.state).toBe("failed");
      expect(settled.outputStorageKey).toBeNull();
      expect(settled.outputStorageDriver).toBeNull();
      expect(backend.deleted).toContain(outputKey);
      // And the sweep can now see it, because nothing references the key.
      const swept = await reconcileCoverRevealNamespace(
        undefined,
        backend.dependencies,
      );
      expect(swept.examined).toBe(0);
    });
  });

  describe("bounded capabilities", () => {
    it("signs a short-lived read of exactly the pinned source", async () => {
      const { asset, claim, backend } = await queuedAndClaimed();
      const read = await signCoverRevealSourceRead(
        claim.job.id,
        claim.leaseToken,
        SETTINGS,
        backend.dependencies,
      );
      expect(read).toMatchObject({ ok: true });
      expect(backend.signedReads).toEqual([{
        key: asset.storageKey,
        expiresInSeconds: SETTINGS.sourceReadExpiresInSeconds,
      }]);
      // A caller that does not hold the lease gets nothing, and cannot tell
      // "wrong lease" from "no such job".
      const foreign = await signCoverRevealSourceRead(
        claim.job.id,
        "not-the-lease-token",
        SETTINGS,
        backend.dependencies,
      );
      expect(foreign).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_NOT_CLAIMED",
      });
      expect(backend.signedReads).toHaveLength(1);
    });

    it("clamps a capability to what is left of the lease", async () => {
      const backend = recordingStorage();
      const { journeyId } = await createJourneyWithCover();
      await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
        backend.dependencies,
      );
      // Claimed so that roughly a minute of the lease remains.
      const claim = await claimCoverRevealJob(
        SETTINGS,
        new Date(Date.now() - (SETTINGS.leaseSeconds - 60) * 1_000),
        backend.dependencies,
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error("unreachable");
      const read = await signCoverRevealSourceRead(
        claim.job.id,
        claim.leaseToken,
        SETTINGS,
        backend.dependencies,
      );
      expect(read).toMatchObject({ ok: true });
      const issued = backend.signedReads[0].expiresInSeconds;
      expect(issued).toBeLessThan(SETTINGS.sourceReadExpiresInSeconds);
      expect(issued).toBeLessThanOrEqual(60);
      expect(issued).toBeGreaterThan(0);
    });

    it("mints nothing once the lease has already closed", async () => {
      const backend = recordingStorage();
      const { journeyId } = await createJourneyWithCover();
      await enqueueCoverRevealDerivative(
        journeyId,
        identity.atlasId,
        backend.dependencies,
      );
      const claim = await claimCoverRevealJob(
        SETTINGS,
        new Date(Date.now() - (SETTINGS.leaseSeconds + 60) * 1_000),
        backend.dependencies,
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error("unreachable");
      expect(await signCoverRevealSourceRead(
        claim.job.id,
        claim.leaseToken,
        SETTINGS,
        backend.dependencies,
      )).toMatchObject({ ok: false, error: "COVER_REVEAL_NOT_LEASED" });
      expect(await signCoverRevealOutputUpload(
        claim.job.id,
        claim.leaseToken,
        SETTINGS,
        backend.dependencies,
      )).toMatchObject({ ok: false, error: "COVER_REVEAL_NOT_LEASED" });
      expect(backend.signedReads).toHaveLength(0);
      expect(backend.signedUploads).toHaveLength(0);
    });

    it("signs an upload only for the claimed job's own object", async () => {
      const { claim, backend } = await queuedAndClaimed();
      const upload = await signCoverRevealOutputUpload(
        claim.job.id,
        claim.leaseToken,
        SETTINGS,
        backend.dependencies,
      );
      expect(upload).toMatchObject({ ok: true });
      const row = await readJob(claim.job.id);
      expect(backend.signedUploads).toHaveLength(1);
      expect(backend.signedUploads[0].key).toBe(row.outputStorageKey);
      expect(backend.signedUploads[0].key.startsWith(COVER_REVEAL_KEY_PREFIX))
        .toBe(true);
      expect(backend.signedUploads[0].mimeType)
        .toBe(COVER_REVEAL_OUTPUT_MIME_TYPE);

      // There is no storage key on this request to point elsewhere: the route
      // reads only a lease token, so an arbitrary key cannot be requested.
      const attempted = await app.request(
        `${TEST_ORIGIN}/api/cover-reveal-worker/jobs/${claim.job.id}/output-upload`,
        {
          method: "POST",
          headers: workerHeaders(),
          body: JSON.stringify({
            leaseToken: claim.leaseToken,
            storageKey: "previews/somebody-elses-object",
            key: "previews/somebody-elses-object",
          }),
        },
      );
      // The core lane has no storage backend, so the real registry degrades
      // truthfully rather than signing anything at all.
      expect(attempted.status).toBe(503);
      expect(backend.signedUploads).toHaveLength(1);
    });

    it("records the issued write without persisting the signed URL", async () => {
      const { claim, backend } = await queuedAndClaimed();
      await signCoverRevealOutputUpload(
        claim.job.id,
        claim.leaseToken,
        SETTINGS,
        backend.dependencies,
      );
      const row = await readJob(claim.job.id);
      const [write] = await db
        .select()
        .from(coverRevealWrites)
        .where(eq(coverRevealWrites.derivativeId, claim.job.id));
      expect(write.storageKey).toBe(row.outputStorageKey);
      for (const value of [...Object.values(row), ...Object.values(write)]) {
        if (typeof value !== "string") continue;
        expect(value).not.toContain("https://");
        expect(value).not.toContain(claim.leaseToken);
        expect(value).not.toContain(WORKER_TOKEN);
      }
    });
  });

  describe("completion", () => {
    async function uploadAndComplete(
      context: Awaited<ReturnType<typeof queuedAndClaimed>>,
      settings: CoverRevealSettings = SETTINGS,
    ) {
      await signCoverRevealOutputUpload(
        context.claim.job.id,
        context.claim.leaseToken,
        settings,
        context.backend.dependencies,
      );
      return completeCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        settings,
        context.backend.dependencies,
      );
    }

    it("publishes a measured object and converges on a repeated call", async () => {
      const context = await queuedAndClaimed();
      const completed = await uploadAndComplete(context);
      expect(completed).toMatchObject({ ok: true });

      const row = await readJob(context.claim.job.id);
      expect(row.state).toBe("ready");
      expect(row.outputMimeType).toBe(COVER_REVEAL_OUTPUT_MIME_TYPE);
      expect(row.outputBytes).toBe(GENERATED_DERIVATIVE.byteLength);
      expect(row.outputWidth).toBe(600);
      expect(row.outputHeight).toBe(467);

      const again = await completeCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      expect(again).toMatchObject({ ok: true });
      const unchanged = await readJob(context.claim.job.id);
      expect(unchanged.state).toBe("ready");
      expect(unchanged.outputBytes).toBe(row.outputBytes);

      // Contradictory, not repeated: a failure report after a publication.
      const contradictory = await failCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        "WORKER_GENERATION_FAILED",
        SETTINGS,
      );
      expect(contradictory).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_NOT_LEASED",
      });
      expect((await readJob(context.claim.job.id)).state).toBe("ready");
    });

    it("converges on a repeated failure and refuses a later completion", async () => {
      const context = await queuedAndClaimed();
      const first = await failCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        "WORKER_SOURCE_UNREADABLE",
        SETTINGS,
      );
      expect(first).toMatchObject({ ok: true });
      const repeated = await failCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        "WORKER_SOURCE_UNREADABLE",
        SETTINGS,
      );
      expect(repeated).toMatchObject({ ok: true });
      const row = await readJob(context.claim.job.id);
      expect(row.state).toBe("queued");
      expect(row.attempts).toBe(1);

      const late = await completeCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      expect(late).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_NOT_LEASED",
      });
      expect((await readJob(context.claim.job.id)).state).toBe("queued");
    });

    it("refuses a completion once the Journey's cover identity moved", async () => {
      const context = await queuedAndClaimed();
      await signCoverRevealOutputUpload(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      // A second image becomes the explicit cover while the worker is running.
      const [replacement] = await db
        .insert(mediaAssets)
        .values({
          journeyId: context.journeyId,
          storageDriver: "s3",
          storageKey: `${identity.atlasId}/${context.journeyId}/${randomUUID()}`,
          fileName: "new-cover.jpg",
          mimeType: "image/jpeg",
          bytes: 1_048_576,
          contentHash: "b".repeat(64),
          contentHashVerified: true,
          sortOrder: 1,
          uploadedByUserId: identity.userId,
        })
        .returning();
      await db
        .update(journeys)
        .set({ coverMediaAssetId: replacement.id })
        .where(eq(journeys.id, context.journeyId));

      const completed = await completeCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      expect(completed).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_SOURCE_CHANGED",
      });
      const row = await readJob(context.claim.job.id);
      expect(row.state).toBe("superseded");
      expect(row.supersededAt).not.toBeNull();
      expect(row.outputStorageKey).toBeNull();
    });

    it("refuses a completion once the pinned source was deleted", async () => {
      const context = await queuedAndClaimed();
      await signCoverRevealOutputUpload(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      await db
        .delete(mediaAssets)
        .where(eq(mediaAssets.id, context.asset.id));

      const completed = await completeCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      expect(completed).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_SOURCE_CHANGED",
      });
      expect((await readJob(context.claim.job.id)).state).toBe("superseded");
    });

    it("leaves a job retryable when the expected object never landed", async () => {
      const context = await queuedAndClaimed(recordingStorage(null));
      const completed = await uploadAndComplete(context);
      expect(completed).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_OUTPUT_MISSING",
      });
      // Retryable, not a decided failure: the lease still owns the job.
      expect((await readJob(context.claim.job.id)).state).toBe("leased");
    });

    it("refuses an object over the byte ceiling", async () => {
      const settings = { ...SETTINGS, maxBytes: 1_024 };
      const context = await queuedAndClaimed(recordingStorage(), settings);
      const leased = await readJob(context.claim.job.id);
      const outputKey = leased.outputStorageKey as string;
      const completed = await uploadAndComplete(context, settings);
      expect(completed).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_OUTPUT_TOO_LARGE",
      });
      const row = await readJob(context.claim.job.id);
      expect(row.state).not.toBe("ready");
      // Settled, so the attempt's object is both dropped and unreferenced.
      expect(context.backend.deleted).toContain(outputKey);
      expect(row.outputStorageKey).toBeNull();
    });

    it("refuses an object over the pixel ceiling", async () => {
      const settings = { ...SETTINGS, maxEdgePixels: 512 };
      const context = await queuedAndClaimed(
        recordingStorage(OVERSIZED_DERIVATIVE),
        settings,
      );
      const completed = await uploadAndComplete(context, settings);
      expect(completed).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_OUTPUT_PIXELS_TOO_LARGE",
      });
      expect((await readJob(context.claim.job.id)).state).not.toBe("ready");
    });

    it("refuses bytes that are not the issued image type at all", async () => {
      const context = await queuedAndClaimed(
        recordingStorage(new TextEncoder().encode("<svg>not a jpeg</svg>")),
      );
      const completed = await uploadAndComplete(context);
      expect(completed).toMatchObject({
        ok: false,
        error: "COVER_REVEAL_OUTPUT_UNREADABLE",
      });
      expect((await readJob(context.claim.job.id)).state).not.toBe("ready");
    });

    /**
     * The invariant the whole slice exists to protect: a successful completion
     * changes the derivative and nothing else.
     */
    it("leaves the canonical cover, its bytes and its order untouched", async () => {
      const context = await queuedAndClaimed();
      const [journeyBefore] = await db
        .select()
        .from(journeys)
        .where(eq(journeys.id, context.journeyId));
      const mediaBefore = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.journeyId, context.journeyId))
        .orderBy(mediaAssets.sortOrder, mediaAssets.id);

      expect(await uploadAndComplete(context)).toMatchObject({ ok: true });

      const [journeyAfter] = await db
        .select()
        .from(journeys)
        .where(eq(journeys.id, context.journeyId));
      const mediaAfter = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.journeyId, context.journeyId))
        .orderBy(mediaAssets.sortOrder, mediaAssets.id);
      expect(journeyAfter.coverMediaAssetId)
        .toBe(journeyBefore.coverMediaAssetId);
      expect(journeyAfter.revision).toBe(journeyBefore.revision);
      expect(mediaAfter).toEqual(mediaBefore);
      const [source] = mediaAfter.filter((row) => row.id === context.asset.id);
      expect(source.storageKey).toBe(context.asset.storageKey);
      expect(source.contentHash).toBe(context.asset.contentHash);
      expect(source.sortOrder).toBe(context.asset.sortOrder);
    });
  });

  describe("invalidation and cleanup", () => {
    it("supersedes a ready derivative and removes its object when the cover changes", async () => {
      const context = await queuedAndClaimed();
      await signCoverRevealOutputUpload(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      );
      expect(await completeCoverRevealJob(
        context.claim.job.id,
        context.claim.leaseToken,
        SETTINGS,
        context.backend.dependencies,
      )).toMatchObject({ ok: true });
      const ready = await readJob(context.claim.job.id);
      const outputKey = ready.outputStorageKey as string;
      expect(context.backend.objects.has(outputKey)).toBe(true);

      await db
        .update(mediaAssets)
        .set({ contentHash: "c".repeat(64) })
        .where(eq(mediaAssets.id, context.asset.id));
      const reconciled = await reconcileCoverRevealDerivatives(
        context.backend.dependencies,
      );
      expect(reconciled.superseded).toBeGreaterThanOrEqual(1);

      const row = await readJob(context.claim.job.id);
      expect(row.state).toBe("superseded");
      expect(row.outputStorageKey).toBeNull();
      expect(context.backend.deleted).toContain(outputKey);
      expect(context.backend.objects.has(outputKey)).toBe(false);
    });

    it("supersedes a live derivative once its Journey starts deleting", async () => {
      const context = await queuedAndClaimed();
      await markJourneyForDeletionForAtlas(
        context.journeyId,
        identity.atlasId,
      );
      await reconcileCoverRevealDerivatives(context.backend.dependencies);
      expect((await readJob(context.claim.job.id)).state).toBe("superseded");
    });

    /**
     * The half that needs no records and no clock: an object under the
     * derivative prefix that no job references is retired, however late it
     * landed. This is also what makes forgetting a write record safe.
     */
    it("retires an unreferenced object from the derivative namespace", async () => {
      const backend = recordingStorage();
      const orphan = `${COVER_REVEAL_KEY_PREFIX}${randomUUID()}`;
      backend.objects.set(orphan, GENERATED_DERIVATIVE);
      const swept = await reconcileCoverRevealNamespace(
        undefined,
        backend.dependencies,
      );
      expect(swept.retired).toBeGreaterThanOrEqual(1);
      expect(backend.deleted).toContain(orphan);
      // The namespace is disjoint from the #260 preview namespace, so neither
      // sweep can retire the other's objects.
      expect(orphan.startsWith("previews/")).toBe(false);
    });

    it("retires the record of a write whose signature has closed", async () => {
      const backend = recordingStorage();
      const key = `${COVER_REVEAL_KEY_PREFIX}${randomUUID()}`;
      backend.objects.set(key, GENERATED_DERIVATIVE);
      await db.insert(coverRevealWrites).values({
        derivativeId: randomUUID(),
        storageDriver: "s3",
        storageKey: key,
        expiresAt: new Date(Date.now() - 60 * 60 * 1_000),
      });
      const reconciled = await reconcileCoverRevealWrites(
        new Date(),
        backend.dependencies,
      );
      expect(reconciled.retired).toBeGreaterThanOrEqual(1);
      expect(backend.deleted).toContain(key);
      const remaining = await db
        .select()
        .from(coverRevealWrites)
        .where(eq(coverRevealWrites.storageKey, key));
      expect(remaining).toHaveLength(0);
    });
  });
});
