/**
 * Frozen API latency harness (perf-measurement skill).
 *
 * Drives the authenticated load path and a 64-point Journey PATCH in-process
 * through `app.request`, against a real PostgreSQL seeded with a synthetic
 * fixture. The primary metric is the DB round-trip count per request, which is
 * deterministic; latency is reported as median and range over alternating
 * rounds after warmup. Output never contains coordinates, URLs, tokens or SQL
 * text: queries are bucketed by target table only.
 *
 * Run: `pnpm exec tsx server/bench/api-latency.ts` with DATABASE_URL set to a
 * disposable database that has been migrated. Not a test file on purpose.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createEmailVerificationToken } from "better-auth/api";
import { inArray } from "drizzle-orm";
import pg from "pg";

const OUTPUT_PATH = process.env.PERF_API_OUTPUT ?? "artifacts/perf-api/api-latency.json";
const SUMMARY_PATH = process.env.PERF_API_SUMMARY ?? "artifacts/perf-api/summary.md";
const WARMUP_ROUNDS = 2;
const MEASURED_ROUNDS = 9;
const READ_URLS_PER_ROUND = 8;
const ORIGIN = "http://127.0.0.1:5173";

// ---------------------------------------------------------------------------
// Query instrumentation: one count per Client.query round trip. Pool.query
// delegates to Client.query and Drizzle transactions call it directly, so
// patching the Client prototype alone counts each round trip exactly once.
// ---------------------------------------------------------------------------
type QueryLog = { total: number; byTable: Record<string, number> };
let queryLog: QueryLog = { total: 0, byTable: {} };

function queryBucket(text: string) {
  const trimmed = text.trim().toLowerCase();
  if (/^(begin|start transaction)\b/.test(trimmed)) return "tx:begin";
  if (/^commit\b/.test(trimmed)) return "tx:commit";
  if (/^rollback\b/.test(trimmed)) return "tx:rollback";
  const verb = trimmed.split(/\s+/, 1)[0] ?? "other";
  const table = /\b(?:from|into|update|join)\s+"?([a-z_][a-z0-9_]*)"?/i.exec(trimmed)?.[1];
  return `${verb}:${table ?? "?"}`;
}

const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function instrumentedQuery(this: pg.Client, ...args: unknown[]) {
  const first = args[0] as string | { text?: string } | undefined;
  const text = typeof first === "string" ? first : first?.text ?? "";
  const bucket = queryBucket(text);
  queryLog.total += 1;
  queryLog.byTable[bucket] = (queryLog.byTable[bucket] ?? 0) + 1;
  return (originalQuery as (...input: unknown[]) => unknown).apply(this, args);
} as typeof pg.Client.prototype.query;

function resetQueryLog() {
  const previous = queryLog;
  queryLog = { total: 0, byTable: {} };
  return previous;
}

async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// Imported after the patch so nothing can bind an unpatched reference.
const { app } = await import("../app");
const { serverConfig } = await import("../config");
const { db, pool } = await import("../db/client");
const { atlases, journeyRoutePoints, journeys, mediaAssets } = await import("../db/app-schema");
const authSchema = await import("../db/auth-schema");

// ---------------------------------------------------------------------------
// Fixture.
// ---------------------------------------------------------------------------
/**
 * A browser-like cookie jar: every cookie the API sets is sent back, exactly
 * as the real client would, so session caching behaves as it does in a tab.
 */
type CookieJar = Map<string, string>;
type Identity = { jar: CookieJar; userId: string; ip: string; atlasId: string; organizationId: string };

function absorbCookies(jar: CookieJar, response: Response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expired = attributes.some((attribute) => {
      const [key, raw = ""] = attribute.trim().split("=");
      if (key.toLowerCase() === "max-age") return Number(raw) <= 0;
      if (key.toLowerCase() === "expires") return Date.parse(raw) <= Date.now();
      return false;
    });
    if (!value || expired) jar.delete(name);
    else jar.set(name, value);
  }
}

function headers(identity: { ip: string; jar?: CookieJar }, json = false) {
  const cookie = identity.jar && identity.jar.size > 0
    ? [...identity.jar].map(([name, value]) => `${name}=${value}`).join("; ")
    : null;
  return {
    origin: ORIGIN,
    "x-forwarded-for": identity.ip,
    ...(json ? { "content-type": "application/json" } : {}),
    ...(cookie ? { cookie } : {}),
  };
}

function assertStatus(response: Response, expected: number[], step: string) {
  if (!expected.includes(response.status)) {
    throw new Error(`${step} returned ${response.status}`);
  }
}

const createdEmails: string[] = [];
const createdOrganizations: string[] = [];
const createdAtlases: string[] = [];

async function createIdentity(label: string, ip: string): Promise<Identity> {
  const email = `bench-${label}-${randomUUID()}@example.test`;
  const password = "bench-only-password-123";
  createdEmails.push(email);
  const anonymous = { ip };
  const signUp = await app.request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: headers(anonymous, true),
    body: JSON.stringify({ name: label, email, password }),
  });
  assertStatus(signUp, [200], "sign-up");
  const token = await createEmailVerificationToken(serverConfig.authSecret, email);
  const verify = await app.request(
    `${ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    { headers: headers(anonymous) },
  );
  assertStatus(verify, [200], "verify-email");
  const signIn = await app.request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: headers(anonymous, true),
    body: JSON.stringify({ email, password }),
  });
  assertStatus(signIn, [200], "sign-in");
  const { user } = await signIn.json() as { user: { id: string } };
  const jar: CookieJar = new Map();
  absorbCookies(jar, signIn);
  if (![...jar.keys()].some((name) => name.endsWith("startrips.session_token"))) {
    throw new Error("sign-in returned no session cookie");
  }
  const authed = { ip, jar };

  const organizationResponse = await app.request(`${ORIGIN}/api/auth/organization/create`, {
    method: "POST",
    headers: headers(authed, true),
    body: JSON.stringify({ name: `${label} Atlas`, slug: `bench-${label}-${randomUUID()}` }),
  });
  assertStatus(organizationResponse, [200], "organization/create");
  absorbCookies(jar, organizationResponse);
  const organization = await organizationResponse.json() as { id: string };
  createdOrganizations.push(organization.id);
  // The product client activates the new Organization explicitly
  // (AuthGateway createOrganization), which also refreshes any cached session
  // cookie; organization/create alone does not.
  const activate = await app.request(`${ORIGIN}/api/auth/organization/set-active`, {
    method: "POST",
    headers: headers(authed, true),
    body: JSON.stringify({ organizationId: organization.id }),
  });
  assertStatus(activate, [200], "organization/set-active");
  absorbCookies(jar, activate);

  const bootstrap = await app.request(`${ORIGIN}/api/atlases/bootstrap`, {
    method: "POST",
    headers: headers(authed, true),
    body: JSON.stringify({ title: `${label} Atlas`, dedication: "bench" }),
  });
  assertStatus(bootstrap, [200, 201], "atlases/bootstrap");
  absorbCookies(jar, bootstrap);
  const { atlas } = await bootstrap.json() as { atlas: { id: string } };
  createdAtlases.push(atlas.id);
  return { jar, userId: user.id, ip, atlasId: atlas.id, organizationId: organization.id };
}

/** Deterministic synthetic coordinates: a spiral, no real places. */
function syntheticPoint(journeyIndex: number, pointIndex: number) {
  const angle = (journeyIndex * 0.7) + (pointIndex * 0.11);
  const radius = 5 + pointIndex * 0.2;
  return {
    latitude: Math.max(-80, Math.min(80, Math.sin(angle) * radius + (journeyIndex % 9) * 7 - 30)),
    longitude: ((((Math.cos(angle) * radius + journeyIndex * 6.9) % 360) + 360) % 360) - 180,
  };
}

type Fixture = { journeyCount: number; pointsFor: (index: number) => number; mediaPerJourney: number };

async function seedAtlas(identity: Identity, fixture: Fixture) {
  const day = (offset: number) => new Date(Date.UTC(2025, 0, 1 + offset)).toISOString().slice(0, 10);
  const journeyRows = await db.insert(journeys).values(
    Array.from({ length: fixture.journeyCount }, (_, index) => ({
      atlasId: identity.atlasId,
      createdByUserId: identity.userId,
      title: `Bench journey ${index + 1}`,
      startedOn: day(index * 3),
      endedOn: day(index * 3 + 2),
      note: "Synthetic benchmark journey. ".repeat(4),
    })),
  ).returning({ id: journeys.id });

  const pointRows: (typeof journeyRoutePoints.$inferInsert)[] = [];
  journeyRows.forEach((journey, journeyIndex) => {
    const count = fixture.pointsFor(journeyIndex);
    for (let pointIndex = 0; pointIndex < count; pointIndex += 1) {
      const isStop = pointIndex === 0 || pointIndex === count - 1 || pointIndex % 5 === 0;
      pointRows.push({
        journeyId: journey.id,
        sortOrder: pointIndex,
        ...syntheticPoint(journeyIndex, pointIndex),
        label: isStop ? `Stop ${pointIndex + 1}` : "",
        isStop,
        // Non-decreasing within a Journey, as parseJourneyInput requires.
        occurredAt: new Date(Date.UTC(2025, 0, 1 + journeyIndex * 3) + pointIndex * 20 * 60_000),
        note: pointIndex % 7 === 0 ? "Synthetic note." : null,
      });
    }
  });
  const insertedPoints: { id: string; journeyId: string }[] = [];
  for (let offset = 0; offset < pointRows.length; offset += 500) {
    insertedPoints.push(...await db.insert(journeyRoutePoints)
      .values(pointRows.slice(offset, offset + 500))
      .returning({ id: journeyRoutePoints.id, journeyId: journeyRoutePoints.journeyId }));
  }
  const firstPointByJourney = new Map<string, string>();
  insertedPoints.forEach((point) => {
    if (!firstPointByJourney.has(point.journeyId)) firstPointByJourney.set(point.journeyId, point.id);
  });

  const mediaRows: (typeof mediaAssets.$inferInsert)[] = [];
  journeyRows.forEach((journey, journeyIndex) => {
    for (let mediaIndex = 0; mediaIndex < fixture.mediaPerJourney; mediaIndex += 1) {
      const withPreview = mediaIndex === 0;
      const key = `bench/${identity.atlasId}/${journey.id}/${mediaIndex}`;
      mediaRows.push({
        journeyId: journey.id,
        routePointId: mediaIndex === 1 ? firstPointByJourney.get(journey.id) ?? null : null,
        storageDriver: serverConfig.s3BackendId ?? "disabled",
        storageKey: key,
        fileName: `bench-${journeyIndex}-${mediaIndex}.jpg`,
        mimeType: "image/jpeg",
        bytes: 1_000_000 + mediaIndex,
        contentHash: randomUUID().replaceAll("-", "").repeat(2),
        sortOrder: mediaIndex,
        uploadedByUserId: identity.userId,
        displayWidth: 4032,
        displayHeight: 3024,
        ...(withPreview
          ? {
              previewStorageKey: `${key}/preview`,
              previewMimeType: "image/webp",
              previewBytes: 80_000,
              previewWidth: 1600,
              previewHeight: 1200,
              previewState: "ready",
            }
          : {}),
      });
    }
  });
  const insertedMedia = mediaRows.length > 0
    ? await db.insert(mediaAssets).values(mediaRows).returning({ id: mediaAssets.id })
    : [];
  return {
    journeyIds: journeyRows.map((row) => row.id),
    mediaIds: insertedMedia.map((row) => row.id),
    routePoints: pointRows.length,
  };
}

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------
type Sample = {
  status: number;
  ms: number;
  bytes: number;
  queries: number;
  byTable: Record<string, number>;
  leakedQueries: number;
  rows?: Record<string, number>;
  ok: boolean;
};

async function measure(
  jar: CookieJar,
  path: string,
  init: RequestInit,
  validate: (status: number, body: unknown) => { ok: boolean; rows?: Record<string, number> },
): Promise<Sample & { body: unknown }> {
  await settle();
  resetQueryLog();
  const started = performance.now();
  const response = await app.request(`${ORIGIN}${path}`, init);
  const buffer = await response.arrayBuffer();
  const ms = performance.now() - started;
  absorbCookies(jar, response);
  await settle();
  const log = resetQueryLog();
  await settle();
  const leaked = resetQueryLog().total;
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    body = null;
  }
  const verdict = validate(response.status, body);
  return {
    status: response.status,
    ms,
    bytes: buffer.byteLength,
    queries: log.total,
    byTable: log.byTable,
    leakedQueries: leaked,
    rows: verdict.rows,
    ok: verdict.ok && response.status >= 200 && response.status < 300,
    body,
  };
}

type JourneyBody = {
  id: string;
  title: string;
  startedOn: string;
  endedOn: string | null;
  note: string;
  lightColor: string;
  revision: number;
  routePoints: Array<Record<string, unknown>>;
  media: unknown[];
};

function patchPayload(journey: JourneyBody, round: number) {
  return {
    title: `Bench patch ${round}`,
    startedOn: journey.startedOn,
    endedOn: journey.endedOn,
    note: journey.note,
    lightColor: journey.lightColor,
    revision: journey.revision,
    routePoints: journey.routePoints.map((point, index) => ({
      id: point.id,
      latitude: point.latitude,
      longitude: point.longitude,
      // Touch every point so each one is a real update, as a full edit is.
      label: point.isStop ? `Stop ${index + 1} r${round % 2}` : "",
      isStop: point.isStop,
      occurredAt: point.occurredAt,
      note: point.note,
      regionContext: point.regionContext,
      placeRole: point.placeRole,
      overviewVisibility: point.overviewVisibility,
      stayAnchorRoutePointId: point.stayAnchorRoutePointId,
    })),
  };
}

type FixtureState = {
  name: string;
  identity: Identity;
  journeyIds: string[];
  mediaIds: string[];
  patchJourney: JourneyBody | null;
  detailJourneyId: string;
  samples: Record<string, Sample[]>;
  loadPath: { ms: number; queries: number; requests: number }[];
};

function record(state: FixtureState, endpoint: string, sample: Sample, measured: boolean) {
  if (!measured) return;
  const { body: _body, ...rest } = sample as Sample & { body?: unknown };
  (state.samples[endpoint] ??= []).push(rest);
}

async function runRound(state: FixtureState, round: number, measured: boolean) {
  const jar = state.identity.jar;
  const auth = { ip: state.identity.ip, jar };
  // Built per request, so a cookie set by one response reaches the next.
  const get = () => ({ headers: headers(auth) });
  let loadMs = 0;
  let loadQueries = 0;
  let loadRequests = 0;
  const onLoadPath = (sample: Sample) => {
    loadMs += sample.ms;
    loadQueries += sample.queries;
    loadRequests += 1;
  };

  const session = await measure(jar, "/api/auth/get-session", get(), (status, body) => ({
    ok: status === 200 && Boolean((body as { session?: { activeOrganizationId?: string } })?.session?.activeOrganizationId),
  }));
  record(state, "GET /api/auth/get-session", session, measured);
  onLoadPath(session);

  const organizations = await measure(jar, "/api/auth/organization/list", get(), (status, body) => ({
    ok: status === 200 && Array.isArray(body) && body.length === 1,
    rows: { organizations: Array.isArray(body) ? body.length : 0 },
  }));
  record(state, "GET /api/auth/organization/list", organizations, measured);
  onLoadPath(organizations);

  const current = await measure(jar, "/api/atlases/current", get(), (status, body) => ({
    ok: status === 200 && (body as { atlas?: { id?: string } })?.atlas?.id === state.identity.atlasId,
  }));
  record(state, "GET /api/atlases/current", current, measured);
  onLoadPath(current);

  const list = await measure(jar, "/api/journeys", get(), (status, body) => {
    const listed = (body as { journeys?: JourneyBody[] })?.journeys ?? [];
    return {
      ok: status === 200 && listed.length === state.journeyIds.length,
      rows: {
        journeys: listed.length,
        routePoints: listed.reduce((sum, journey) => sum + journey.routePoints.length, 0),
        media: listed.reduce((sum, journey) => sum + journey.media.length, 0),
      },
    };
  });
  record(state, "GET /api/journeys", list, measured);
  onLoadPath(list);

  for (let index = 0; index < READ_URLS_PER_ROUND; index += 1) {
    const assetId = state.mediaIds[(round * READ_URLS_PER_ROUND + index) % state.mediaIds.length];
    const read = await measure(jar, `/api/uploads/assets/${assetId}/read-url`, get(), (status, body) => ({
      ok: status === 200 && typeof (body as { url?: unknown })?.url === "string",
      rows: { previews: (body as { preview?: unknown })?.preview ? 1 : 0 },
    }));
    record(state, "GET /api/uploads/assets/:id/read-url", read, measured);
    onLoadPath(read);
  }
  if (measured) state.loadPath.push({ ms: loadMs, queries: loadQueries, requests: loadRequests });

  const detail = await measure(jar, `/api/journeys/${state.detailJourneyId}`, get(), (status, body) => {
    const journey = (body as { journey?: JourneyBody })?.journey;
    return {
      ok: status === 200 && journey?.id === state.detailJourneyId,
      rows: { routePoints: journey?.routePoints.length ?? 0, media: journey?.media.length ?? 0 },
    };
  });
  record(state, "GET /api/journeys/:id", detail, measured);
  if (!state.patchJourney) state.patchJourney = (detail.body as { journey: JourneyBody }).journey;

  const before = state.patchJourney;
  const patch = await measure(jar, `/api/journeys/${before.id}`, {
    method: "PATCH",
    headers: headers(auth, true),
    body: JSON.stringify(patchPayload(before, round)),
  }, (status, body) => {
    const journey = (body as { journey?: JourneyBody })?.journey;
    return {
      ok: status === 200
        && journey?.revision === before.revision + 1
        && journey.routePoints.length === before.routePoints.length
        && journey.routePoints.every((point, index) => point.id === before.routePoints[index]?.id),
      rows: { routePoints: journey?.routePoints.length ?? 0 },
    };
  });
  record(state, `PATCH /api/journeys/:id (${before.routePoints.length} points)`, patch, measured);
  if (patch.ok) state.patchJourney = (patch.body as { journey: JourneyBody }).journey;
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { median: round(median), min: round(sorted[0]), max: round(sorted[sorted.length - 1]) };
}

function summarize(state: FixtureState) {
  const endpoints: Record<string, unknown> = {};
  for (const [endpoint, samples] of Object.entries(state.samples)) {
    endpoints[endpoint] = {
      requests: samples.length,
      errors: samples.filter((sample) => !sample.ok).length,
      non2xx: samples.filter((sample) => sample.status < 200 || sample.status >= 300).length,
      statuses: [...new Set(samples.map((sample) => sample.status))],
      queries: stats(samples.map((sample) => sample.queries)),
      queriesByTable: samples[samples.length - 1]?.byTable ?? {},
      leakedQueries: samples.reduce((sum, sample) => sum + sample.leakedQueries, 0),
      latencyMs: stats(samples.map((sample) => sample.ms)),
      bytes: stats(samples.map((sample) => sample.bytes)),
      rows: samples[samples.length - 1]?.rows ?? {},
    };
  }
  return {
    fixture: state.name,
    journeys: state.journeyIds.length,
    media: state.mediaIds.length,
    endpoints,
    loadPath: {
      description: `get-session -> organization/list -> atlases/current -> journeys -> ${READ_URLS_PER_ROUND} x read-url, serial`,
      requests: state.loadPath[0]?.requests ?? 0,
      queries: stats(state.loadPath.map((entry) => entry.queries)),
      latencyMs: stats(state.loadPath.map((entry) => entry.ms)),
    },
  };
}

async function cleanup() {
  if (createdAtlases.length > 0) await db.delete(atlases).where(inArray(atlases.id, createdAtlases));
  if (createdOrganizations.length > 0) {
    await db.delete(authSchema.organization).where(inArray(authSchema.organization.id, createdOrganizations));
  }
  if (createdEmails.length > 0) await db.delete(authSchema.user).where(inArray(authSchema.user.email, createdEmails));
}

async function main() {
  if (!serverConfig.s3BackendId) {
    throw new Error("The harness needs STORAGE_DRIVER=s3 settings so read-url signs (signing is local, no network)");
  }
  const large = await createIdentity("large", "198.51.100.10");
  const small = await createIdentity("small", "198.51.100.20");
  const largeSeed = await seedAtlas(large, {
    journeyCount: 50,
    pointsFor: (index) => (index === 0 ? 64 : 2 + ((index * 13) % 63)),
    mediaPerJourney: 3,
  });
  const smallSeed = await seedAtlas(small, { journeyCount: 1, pointsFor: () => 2, mediaPerJourney: 1 });

  const states: FixtureState[] = [
    { name: "large-50x64", identity: large, ...largeSeed, detailJourneyId: largeSeed.journeyIds[0], patchJourney: null, samples: {}, loadPath: [] },
    { name: "small-1x2", identity: small, ...smallSeed, detailJourneyId: smallSeed.journeyIds[0], patchJourney: null, samples: {}, loadPath: [] },
  ];

  const total = WARMUP_ROUNDS + MEASURED_ROUNDS;
  for (let round = 0; round < total; round += 1) {
    const order = round % 2 === 0 ? states : [...states].reverse();
    for (const state of order) await runRound(state, round, round >= WARMUP_ROUNDS);
  }

  const result = {
    harness: "server/bench/api-latency.ts",
    version: 2,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      nodeEnv: process.env.NODE_ENV ?? "(unset)",
      gitSha: process.env.GITHUB_SHA ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      poolMax: pool.options.max,
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
      readUrlsPerRound: READ_URLS_PER_ROUND,
      transport: "in-process app.request (no socket, no TLS); PostgreSQL over localhost TCP",
    },
    fixtures: states.map(summarize),
  };
  // A query that lands after a request's sample window would be missing from
  // that request's count, so any leak invalidates the run like an error does.
  let errorCount = 0;
  let leakedCount = 0;
  for (const fixture of result.fixtures) {
    for (const endpoint of Object.values(fixture.endpoints)) {
      errorCount += (endpoint as { errors: number }).errors;
      leakedCount += (endpoint as { leakedQueries: number }).leakedQueries;
    }
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);

  const lines = [
    `## API latency harness (${MEASURED_ROUNDS} measured rounds after ${WARMUP_ROUNDS} warmup)`,
    "",
    "| fixture | endpoint | queries (med) | p50 ms | range ms | bytes (med) | errors | leaked queries |",
    "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |",
  ];
  for (const fixture of result.fixtures) {
    for (const [endpoint, value] of Object.entries(fixture.endpoints)) {
      const entry = value as {
        queries: { median: number }; latencyMs: { median: number; min: number; max: number };
        bytes: { median: number }; errors: number; leakedQueries: number;
      };
      lines.push(`| ${fixture.fixture} | ${endpoint} | ${entry.queries.median} | ${entry.latencyMs.median} | ${entry.latencyMs.min}-${entry.latencyMs.max} | ${entry.bytes.median} | ${entry.errors} | ${entry.leakedQueries} |`);
    }
    lines.push(`| ${fixture.fixture} | load path (${fixture.loadPath.requests} requests) | ${fixture.loadPath.queries.median} | ${fixture.loadPath.latencyMs.median} | ${fixture.loadPath.latencyMs.min}-${fixture.loadPath.latencyMs.max} | | | |`);
  }
  lines.push("", `Total errors: ${errorCount}`, `Total leaked queries: ${leakedCount}`);
  writeFileSync(SUMMARY_PATH, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));

  if (errorCount > 0) throw new Error(`${errorCount} measured requests failed validation`);
  if (leakedCount > 0) throw new Error(`${leakedCount} queries ran outside their request's sample window`);
}

try {
  await main();
} finally {
  try {
    await cleanup();
  } catch (error) {
    console.error("bench cleanup failed", error instanceof Error ? error.message : error);
  }
  await pool.end();
}
