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
  COVER_REVEAL_DEFAULT_PRESET_ID,
  COVER_REVEAL_GENERATION_KIND,
  COVER_REVEAL_GENERATION_VERSION,
  COVER_REVEAL_KEY_PREFIX,
  COVER_REVEAL_OUTPUT_MIME_TYPE,
  enqueueCoverRevealDerivative,
  failCoverRevealJob,
  readCoverRevealDisplay,
  reconcileCoverRevealDerivatives,
  signCoverRevealOutputUpload,
  type CoverRevealDependencies,
  type CoverRevealSettings,
} from "../services/cover-reveal";
import { disabledStorage } from "../storage/disabled-storage";
import type { MultipartStorage } from "../storage/multipart-storage";

/**
 * #386 (the Backend read slice of #367): the ordinary browser's half of the
 * cover-reveal contract, kept in its own file rather than appended to
 * `cover-reveal-worker.integration.test.ts`.
 *
 * The separation is the point of the issue. That file is about a machine
 * credential, a lease and the object a worker produces; this one is about a
 * member session asking what it may paint, and the two authorities must not
 * read as one surface with two modes. `media-preview` and `share-grants` build
 * their own identity and storage doubles for the same reason, so the helpers
 * below are deliberately local copies.
 */

const TEST_ORIGIN = "http://127.0.0.1:5173";

/** The same real 600x467 JPEG the worker suite publishes. */
const GENERATED_DERIVATIVE = new Uint8Array(readFileSync(
  new URL("./fixtures/derived-preview-600x467.jpg", import.meta.url),
));

const SETTINGS: CoverRevealSettings = {
  leaseSeconds: 600,
  sourceReadExpiresInSeconds: 300,
  uploadExpiresInSeconds: 600,
  maxBytes: 512 * 1024,
  maxEdgePixels: 1024,
  maxAttempts: 3,
};

/** The TTL the route passes: the owner's own private-media read policy. */
const DISPLAY_TTL_SECONDS = serverConfig.mediaReadUrlExpiresInSeconds;

const WORKER_TOKEN = `worker-${"q".repeat(40)}`;
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

function bearerHeaders(token: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    authorization: `Bearer ${token}`,
  };
}

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
 * A storage adapter that records every signature it was asked for and holds
 * real bytes, so "the display URL was signed for the derivative object and for
 * nothing else" is an assertion about a recorded call rather than about a
 * shape. The core lane runs `STORAGE_DRIVER=disabled`; the truthful
 * degradation of the real registry is asserted separately.
 */
function recordingStorage() {
  const signedReads: Array<{ key: string; expiresInSeconds: number }> = [];
  const objects = new Map<string, Uint8Array>();
  const storage: MultipartStorage = {
    ...disabledStorage,
    driver: "s3",
    async signObjectUpload(input) {
      objects.set(input.key, GENERATED_DERIVATIVE);
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
  return { signedReads, objects, dependencies };
}

describe("#386 cover-reveal display read", () => {
  let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
  let stranger: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;

  beforeAll(async () => {
    mutableConfig.coverRevealWorkerToken = WORKER_TOKEN;
    identity = await createAuthenticatedAtlas("revealowner");
    stranger = await createAuthenticatedAtlas("revealstranger");
  });

  /** The claim is a queue over the whole table; every case starts empty. */
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

  async function addVisualAsset(journeyId: string, sortOrder: number) {
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId,
        storageDriver: "s3",
        storageKey: `${identity.atlasId}/${journeyId}/${randomUUID()}`,
        fileName: "cover.jpg",
        mimeType: "image/jpeg",
        bytes: 4_194_304,
        contentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        contentHashVerified: true,
        sortOrder,
        uploadedByUserId: identity.userId,
      })
      .returning();
    return asset;
  }

  async function createJourneyWithCover() {
    const journey = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, title: `Cover reveal ${randomUUID()}` },
    );
    const journeyId = (journey as { id: string }).id;
    return { journeyId, asset: await addVisualAsset(journeyId, 0) };
  }

  /** Enqueue, claim, upload and publish: a `ready` row made the real way. */
  async function publishedDerivative() {
    const backend = recordingStorage();
    const { journeyId, asset } = await createJourneyWithCover();
    const enqueued = await enqueueCoverRevealDerivative(
      journeyId,
      identity.atlasId,
      backend.dependencies,
    );
    expect(enqueued.ok).toBe(true);
    const claim = await claimCoverRevealJob(
      SETTINGS,
      new Date(),
      backend.dependencies,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("unreachable");
    await signCoverRevealOutputUpload(
      claim.job.id,
      claim.leaseToken,
      SETTINGS,
      backend.dependencies,
    );
    const completed = await completeCoverRevealJob(
      claim.job.id,
      claim.leaseToken,
      SETTINGS,
      backend.dependencies,
    );
    expect(completed).toMatchObject({ ok: true });
    const [row] = await db
      .select()
      .from(coverRevealDerivatives)
      .where(eq(coverRevealDerivatives.id, claim.job.id));
    expect(row.state).toBe("ready");
    return { journeyId, asset, backend, row, claim };
  }

  function read(
    journeyId: string,
    backend: ReturnType<typeof recordingStorage>,
    atlasId = identity.atlasId,
  ) {
    return readCoverRevealDisplay(
      journeyId,
      atlasId,
      DISPLAY_TTL_SECONDS,
      backend.dependencies,
    );
  }

  describe("a ready derivative for the exact current cover", () => {
    it("returns the display metadata and a capability for that one object", async () => {
      const { journeyId, asset, backend, row } = await publishedDerivative();
      const result = await read(journeyId, backend);

      expect(result).toMatchObject({ ok: true });
      if (!result.ok || !result.derivative) throw new Error("expected display");
      expect(result.derivative).toEqual({
        id: row.id,
        journeyId,
        generationKind: COVER_REVEAL_GENERATION_KIND,
        generationVersion: COVER_REVEAL_GENERATION_VERSION,
        presetId: COVER_REVEAL_DEFAULT_PRESET_ID,
        sourceMediaAssetId: asset.id,
        sourceContentHash: asset.contentHash,
        mimeType: COVER_REVEAL_OUTPUT_MIME_TYPE,
        width: 600,
        height: 467,
      });

      // Exactly one signature, over the published derivative object — not the
      // source the worker read, and not a key any caller named.
      expect(backend.signedReads).toHaveLength(1);
      expect(backend.signedReads[0].key).toBe(row.outputStorageKey);
      expect(backend.signedReads[0].key.startsWith(COVER_REVEAL_KEY_PREFIX))
        .toBe(true);
      expect(backend.signedReads[0].key).not.toBe(asset.storageKey);
      expect(backend.signedReads[0].expiresInSeconds).toBe(DISPLAY_TTL_SECONDS);
      expect(result.display.expiresAt.valueOf())
        .toBeLessThanOrEqual(Date.now() + DISPLAY_TTL_SECONDS * 1_000);
    });

    /**
     * The metadata is a fixed field set, asserted as a whole. A worker's view
     * of the same row carries `seed`, `attempts` and `lastErrorCode`; none of
     * them, and no key, hash or URL of the processing protocol, may widen this
     * surface by being added to the row later.
     */
    it("carries no worker, lease or storage internals", async () => {
      const { journeyId, backend, row, asset } = await publishedDerivative();
      const result = await read(journeyId, backend);
      if (!result.ok || !result.derivative) throw new Error("expected display");

      expect(Object.keys(result.derivative).sort()).toEqual([
        "generationKind",
        "generationVersion",
        "height",
        "id",
        "journeyId",
        "mimeType",
        "presetId",
        "sourceContentHash",
        "sourceMediaAssetId",
        "width",
      ]);

      const serialized = JSON.stringify({
        derivative: result.derivative,
        display: {
          url: result.display.url,
          expiresAt: result.display.expiresAt.toISOString(),
        },
      });
      for (
        const secret of [
          row.outputStorageKey!,
          row.leaseTokenHash!,
          asset.storageKey,
          WORKER_TOKEN,
          COVER_REVEAL_KEY_PREFIX,
        ]
      ) {
        expect(serialized).not.toContain(secret);
      }
      // `seed` is deliberately absent from the key set above rather than from
      // this list: it is derived from the pinned content hash, which this
      // response exposes on purpose, so a substring assertion about it would
      // only be asserting that derivation. It is not a secret — it is a
      // processing input a display client has no use for.
      expect(serialized).not.toContain("storage.test/put/");
      expect(serialized).not.toContain("attempts");
      expect(serialized).not.toContain("lastErrorCode");
    });
  });

  describe("nothing to display", () => {
    it("says so without enqueuing anything", async () => {
      const backend = recordingStorage();
      const { journeyId } = await createJourneyWithCover();
      const result = await read(journeyId, backend);

      expect(result).toEqual({
        ok: true,
        derivative: null,
        reason: "NO_READY_DERIVATIVE",
      });
      // The read has no side effect: it did not queue the work it just
      // reported missing, and it signed nothing.
      const rows = await db
        .select({ id: coverRevealDerivatives.id })
        .from(coverRevealDerivatives)
        .where(eq(coverRevealDerivatives.journeyId, journeyId));
      expect(rows).toHaveLength(0);
      expect(backend.signedReads).toHaveLength(0);
    });

    it("refuses every lifecycle that is not ready", async () => {
      // queued
      const queuedBackend = recordingStorage();
      const queued = await createJourneyWithCover();
      await enqueueCoverRevealDerivative(
        queued.journeyId,
        identity.atlasId,
        queuedBackend.dependencies,
      );
      expect(await read(queued.journeyId, queuedBackend))
        .toMatchObject({ derivative: null, reason: "NO_READY_DERIVATIVE" });

      // leased
      const claim = await claimCoverRevealJob(
        SETTINGS,
        new Date(),
        queuedBackend.dependencies,
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error("unreachable");
      expect(await read(queued.journeyId, queuedBackend))
        .toMatchObject({ derivative: null, reason: "NO_READY_DERIVATIVE" });

      // failed, terminally: the retry budget is spent in one call because the
      // claim already consumed the last attempt.
      const terminal = await failCoverRevealJob(
        claim.job.id,
        claim.leaseToken,
        "WORKER_GENERATION_FAILED",
        { ...SETTINGS, maxAttempts: 1 },
        queuedBackend.dependencies,
      );
      expect(terminal).toMatchObject({ ok: true });
      const [failedRow] = await db
        .select()
        .from(coverRevealDerivatives)
        .where(eq(coverRevealDerivatives.id, claim.job.id));
      expect(failedRow.state).toBe("failed");
      expect(await read(queued.journeyId, queuedBackend))
        .toMatchObject({ derivative: null, reason: "NO_READY_DERIVATIVE" });
      expect(queuedBackend.signedReads).toHaveLength(0);
    });

    /**
     * A superseded row is not resurrected by the cover coming back.
     *
     * The derivative is published, the cover is moved so the invalidation pass
     * retires it, and the cover is then restored to exactly the asset and the
     * verified identity it was pinned to. The pin matches again — and the row
     * is still not displayable, because `superseded` is terminal and its
     * object is gone.
     */
    it("never displays a superseded row, even once the cover returns", async () => {
      const { journeyId, asset, backend, row } = await publishedDerivative();
      const replacement = await addVisualAsset(journeyId, 1);
      await db
        .update(journeys)
        .set({ coverMediaAssetId: replacement.id })
        .where(eq(journeys.id, journeyId));
      await reconcileCoverRevealDerivatives(backend.dependencies);

      const [supersededRow] = await db
        .select()
        .from(coverRevealDerivatives)
        .where(eq(coverRevealDerivatives.id, row.id));
      expect(supersededRow.state).toBe("superseded");

      await db
        .update(journeys)
        .set({ coverMediaAssetId: asset.id })
        .where(eq(journeys.id, journeyId));
      expect(await read(journeyId, backend))
        .toMatchObject({ derivative: null, reason: "NO_READY_DERIVATIVE" });
      expect(backend.signedReads).toHaveLength(0);
    });

    it("reports an unusable cover as a plain fallback rather than an error", async () => {
      const backend = recordingStorage();
      const journey = await createJourneyForAtlas(
        identity.atlasId,
        identity.userId,
        { ...baseJourney, title: `No cover ${randomUUID()}` },
      );
      const journeyId = (journey as { id: string }).id;
      expect(await read(journeyId, backend))
        .toEqual({ ok: true, derivative: null, reason: "NO_COVER" });

      const unverified = await createJourneyWithCover();
      await db
        .update(mediaAssets)
        .set({ contentHashVerified: false })
        .where(eq(mediaAssets.id, unverified.asset.id));
      expect(await read(unverified.journeyId, backend)).toEqual({
        ok: true,
        derivative: null,
        reason: "SOURCE_IDENTITY_UNVERIFIED",
      });
    });
  });

  describe("the current cover is re-resolved on every issuance", () => {
    it("stops issuing display URLs the moment the cover is replaced", async () => {
      const { journeyId, backend } = await publishedDerivative();
      const first = await read(journeyId, backend);
      expect(first).toMatchObject({ ok: true });
      if (!first.ok || !first.derivative) throw new Error("expected display");

      // The member points the cover at another image of the same Journey. No
      // invalidation pass runs, and the client still holds the metadata
      // payload it was handed a moment ago.
      const replacement = await addVisualAsset(journeyId, 1);
      await db
        .update(journeys)
        .set({ coverMediaAssetId: replacement.id })
        .where(eq(journeys.id, journeyId));

      expect(await read(journeyId, backend))
        .toMatchObject({ derivative: null, reason: "NO_READY_DERIVATIVE" });
      expect(backend.signedReads).toHaveLength(1);
    });

    it("stops issuing display URLs when the pinned source is deleted", async () => {
      const { journeyId, asset, backend } = await publishedDerivative();
      await db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id));
      expect(await read(journeyId, backend))
        .toMatchObject({ derivative: null, reason: "NO_COVER" });
      expect(backend.signedReads).toHaveLength(0);
    });

    it("stops issuing display URLs for a Journey that is deleting", async () => {
      const { journeyId, backend } = await publishedDerivative();
      await markJourneyForDeletionForAtlas(journeyId, identity.atlasId);
      expect(await read(journeyId, backend))
        .toMatchObject({ derivative: null, reason: "JOURNEY_UNAVAILABLE" });
      expect(backend.signedReads).toHaveLength(0);
    });

    it("fails closed across Atlases without leaking that a derivative exists", async () => {
      const { journeyId, backend } = await publishedDerivative();
      // Another Atlas naming a Journey it does not own, and this Atlas naming
      // a Journey that does not exist, are the same answer.
      expect(await read(journeyId, backend, stranger.atlasId))
        .toEqual({ ok: false, error: "JOURNEY_UNAVAILABLE", status: 404 });
      expect(await read(randomUUID(), backend))
        .toEqual({ ok: false, error: "JOURNEY_UNAVAILABLE", status: 404 });
      expect(backend.signedReads).toHaveLength(0);
    });
  });

  describe("the browser route's authority", () => {
    async function get(journeyId: string, headers: Record<string, string>) {
      return app.request(
        `${TEST_ORIGIN}/api/cover-reveal/journeys/${journeyId}`,
        { headers },
      );
    }

    it("answers an owner session, privately and without a shared cache", async () => {
      const { journeyId } = await createJourneyWithCover();
      const response = await get(journeyId, authHeaders(identity.cookie));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json())
        .toEqual({ derivative: null, reason: "NO_READY_DERIVATIVE" });
    });

    /**
     * The worker credential and a share grant are both bearer tokens, and this
     * server has no bearer-to-session path at all — `server/auth.ts` loads the
     * `organization` plugin only — so presenting either here resolves no
     * session and answers exactly as presenting nothing does.
     */
    it("accepts neither the worker credential nor a guest share token", async () => {
      const { journeyId } = await createJourneyWithCover();

      const shareResponse = await app.request(`${TEST_ORIGIN}/api/shares`, {
        method: "POST",
        headers: authHeaders(identity.cookie),
        body: JSON.stringify({
          journeyIds: [journeyId],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      });
      expect(shareResponse.status).toBe(201);
      const { token: shareToken } = await shareResponse.json() as {
        token: string;
      };

      const anonymous = await get(journeyId, authHeaders());
      expect(anonymous.status).toBe(401);
      const anonymousBody = await anonymous.json();

      for (const token of [WORKER_TOKEN, shareToken]) {
        const response = await get(journeyId, bearerHeaders(token));
        expect(response.status).toBe(401);
        // Byte for byte the anonymous answer: neither token is a principal
        // this surface can even describe, so nothing about the Journey or its
        // derivative is observable through one.
        expect(await response.json()).toEqual(anonymousBody);
      }
    });

    it("answers a malformed or unknown Journey id as an unknown Journey", async () => {
      for (const id of ["not-a-uuid", randomUUID()]) {
        const response = await get(id, authHeaders(identity.cookie));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "JOURNEY_UNAVAILABLE" });
      }
    });

    /**
     * A deployment with no object storage cannot serve the derivative, and
     * says so rather than answering metadata with no capability. The route
     * uses the real registry, which is `disabled` in this lane.
     */
    it("degrades truthfully when the deployment has no storage backend", async () => {
      const { journeyId } = await publishedDerivative();
      const response = await get(journeyId, authHeaders(identity.cookie));
      expect(response.status).toBe(503);
      expect(await response.json())
        .toMatchObject({ error: "STORAGE_UNAVAILABLE" });
    });
  });
});
