import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atlases,
  homeBasePeriods,
  journeyRoutePoints,
  journeys,
  mediaAssets,
} from "../db/app-schema";
import { db, pool } from "../db/client";
import {
  countHomeBasePeriodsForAtlas,
  createHomeBasePeriodForAtlas,
  deleteHomeBasePeriodForAtlas,
  listHomeBasePeriodsForAtlas,
  readHomeBaseDismissalForAtlas,
  recordHomeBaseDismissalForAtlas,
  updateHomeBasePeriodForAtlas,
} from "../repositories/home-base-repository";
import { createJourneyForAtlas } from "../repositories/journey-repository";
import { resolveHomeBaseForDate } from "../../src/journey/homeBase";
import {
  inferHomeBaseCandidate,
  type HomeBaseInferenceJourney,
  type HomeBaseInferenceResult,
} from "../../src/journey/homeBaseInference";
import {
  homeBaseConfirmationDraft,
  resolveHomeBaseSuggestion,
} from "../../src/journey/homeBaseSuggestion";

/**
 * #231: the deletion, cascade and cross-Atlas guarantees, against the real
 * PostgreSQL 17 the `core` CI lane provisions.
 *
 * Home Base history and recorded travel are separate records that never
 * reference each other, and these are the assertions that keep them that way:
 * removing where someone lived must not remove where they went, and one
 * Atlas's history must be unreachable from another.
 */

const atlasIds: string[] = [];

const baseJourney = {
  startedOn: "2024-04-18",
  endedOn: "2024-04-20",
  note: "private",
  lightColor: "#f4ce73",
  routePoints: [
    {
      latitude: 22.543096,
      longitude: 114.057865,
      label: "Shenzhen",
      isStop: true,
      occurredAt: new Date("2024-04-18T00:00:00Z"),
    },
    {
      latitude: 22.198745,
      longitude: 113.543873,
      label: "",
      isStop: false,
      occurredAt: new Date("2024-04-19T00:00:00Z"),
    },
  ],
};

const SHENZHEN = {
  label: "Shenzhen",
  latitude: 22.543096,
  longitude: 114.057865,
  startedOn: "2022-06-01",
  endedOn: null,
  source: "manual" as const,
};
const TOKYO = {
  label: "Tokyo",
  latitude: 35.689487,
  longitude: 139.691711,
  startedOn: "2026-09-01",
  endedOn: null,
  source: "suggested-confirmed" as const,
};

async function freshAtlas(label: string): Promise<string> {
  const [atlas] = await db
    .insert(atlases)
    .values({
      organizationId: `test-org-home-base-int-${label}-${randomUUID()}`,
      title: `${label} Atlas`,
    })
    .returning({ id: atlases.id });
  atlasIds.push(atlas.id);
  return atlas.id;
}

async function rowCount(table: typeof journeys | typeof homeBasePeriods, atlasId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(table)
    .where(eq(table.atlasId, atlasId));
  return Number(row.total);
}

let atlasA = "";
let atlasB = "";
let journeyA = "";
let routePointCountA = 0;
let mediaAssetIdA = "";

beforeAll(async () => {
  atlasA = await freshAtlas("first");
  atlasB = await freshAtlas("second");

  const journey = await createJourneyForAtlas(atlasA, "user-home-base", {
    ...baseJourney,
    title: "Shenzhen to Macau",
  });
  if (!journey) throw new Error("Journey fixture was not created");
  journeyA = journey.id;

  const [points] = await db
    .select({ total: count() })
    .from(journeyRoutePoints)
    .where(eq(journeyRoutePoints.journeyId, journeyA));
  routePointCountA = Number(points.total);
  expect(routePointCountA).toBe(2);

  const [asset] = await db
    .insert(mediaAssets)
    .values({
      journeyId: journeyA,
      storageDriver: "disabled",
      storageKey: `test/home-base/${randomUUID()}.jpg`,
      fileName: "shenzhen.jpg",
      mimeType: "image/jpeg",
      bytes: 1024,
      uploadedByUserId: "user-home-base",
    })
    .returning({ id: mediaAssets.id });
  mediaAssetIdA = asset.id;
});

afterAll(async () => {
  if (atlasIds.length > 0) {
    await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  }
  await pool.end();
});

describe("home base history beside recorded travel", () => {
  it("leaves journeys, route points and media intact when a period is deleted", async () => {
    const period = await createHomeBasePeriodForAtlas(atlasA, SHENZHEN);
    expect(period).toBeTruthy();
    expect(await deleteHomeBasePeriodForAtlas(atlasA, period!.id))
      .toEqual({ id: period!.id });

    expect(await rowCount(journeys, atlasA)).toBe(1);
    const [points] = await db
      .select({ total: count() })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyA));
    expect(Number(points.total)).toBe(routePointCountA);
    const [assets] = await db
      .select({ total: count() })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, mediaAssetIdA));
    expect(Number(assets.total)).toBe(1);
    expect(await countHomeBasePeriodsForAtlas(atlasA)).toBe(0);
  });

  it("resolves a journey's date against the history without storing anything on the route", async () => {
    const shenzhen = await createHomeBasePeriodForAtlas(atlasA, SHENZHEN);
    const tokyo = await createHomeBasePeriodForAtlas(atlasA, TOKYO);
    const history = await listHomeBasePeriodsForAtlas(atlasA);

    const [journey] = await db
      .select({ startedOn: journeys.startedOn })
      .from(journeys)
      .where(eq(journeys.id, journeyA));
    // The 2024 journey resolves to Shenzhen even though the current home is
    // now Tokyo: the later move added a chapter, it did not rewrite this one.
    expect(resolveHomeBaseForDate(history, journey.startedOn)?.id)
      .toBe(shenzhen!.id);
    expect(resolveHomeBaseForDate(history, "2027-01-01")?.id).toBe(tokyo!.id);

    // And no route point carries a home base value: the columns simply do not
    // exist, which is what makes the resolution above the only mechanism.
    const [point] = await db
      .select()
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyA))
      .limit(1);
    expect(Object.keys(point).sort()).toEqual([
      "createdAt",
      "id",
      "isStop",
      "journeyId",
      "label",
      "latitude",
      "longitude",
      "note",
      "occurredAt",
      "sortOrder",
    ]);
  });
});

describe("atlas ownership", () => {
  it("keeps one atlas's periods unreadable and unmutable from another", async () => {
    const foreign = await createHomeBasePeriodForAtlas(atlasB, {
      ...SHENZHEN,
      label: "Lisbon",
      startedOn: "2018-01-01",
      endedOn: "2019-01-01",
    });
    expect(foreign).toBeTruthy();

    const seenFromA = await listHomeBasePeriodsForAtlas(atlasA);
    expect(seenFromA.map((period) => period.id)).not.toContain(foreign!.id);

    expect(await updateHomeBasePeriodForAtlas(atlasA, foreign!.id, {
      label: "Stolen",
    })).toBeUndefined();
    expect(await deleteHomeBasePeriodForAtlas(atlasA, foreign!.id))
      .toBeUndefined();

    const [row] = await db
      .select({ label: homeBasePeriods.label })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.id, foreign!.id));
    expect(row.label).toBe("Lisbon");
  });

  it("removes an atlas's periods when the atlas is deleted", async () => {
    const doomed = await freshAtlas("doomed");
    const period = await createHomeBasePeriodForAtlas(doomed, SHENZHEN);
    expect(await rowCount(homeBasePeriods, doomed)).toBe(1);

    await db.delete(atlases).where(eq(atlases.id, doomed));

    const remaining = await db
      .select({ id: homeBasePeriods.id })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.id, period!.id));
    expect(remaining).toEqual([]);
    // The other atlas's history is untouched by that cascade.
    expect(await countHomeBasePeriodsForAtlas(atlasA)).toBe(2);
  });

  it("refuses every write for an atlas that is being deleted", async () => {
    const closing = await freshAtlas("closing");
    const period = await createHomeBasePeriodForAtlas(closing, SHENZHEN);
    expect(period).toBeTruthy();

    await db
      .update(atlases)
      .set({ deletionStartedAt: new Date() })
      .where(eq(atlases.id, closing));

    // Create, amend and removal all serialize on the same Atlas lock, so all
    // three see the deletion mark instead of writing behind it.
    expect(await createHomeBasePeriodForAtlas(closing, TOKYO)).toBeUndefined();
    expect(await updateHomeBasePeriodForAtlas(closing, period!.id, {
      label: "Too late",
    })).toBeUndefined();
    expect(await deleteHomeBasePeriodForAtlas(closing, period!.id))
      .toBeUndefined();
    expect(await countHomeBasePeriodsForAtlas(closing)).toBe(1);
  });
});

/**
 * #232: the persisted half of the suggestion surface.
 *
 * The anti-nag rule is only real if the answer outlives the session, so the
 * digest makes a full round trip through PostgreSQL here before it is fed back
 * into the frozen inference core.
 */

const SHENZHEN_POINT = { latitude: 22.5431, longitude: 114.0579 };

function inferenceJourney(id: string, startedOn: string): HomeBaseInferenceJourney {
  return {
    id,
    startedOn,
    endedOn: startedOn,
    routePoints: [
      { id: `${id}-start`, sortOrder: 0, ...SHENZHEN_POINT },
      { id: `${id}-end`, sortOrder: 1, ...SHENZHEN_POINT },
    ],
  };
}

function shenzhenFour(): HomeBaseInferenceJourney[] {
  return [
    inferenceJourney("j1", "2026-01-01"),
    inferenceJourney("j2", "2026-02-01"),
    inferenceJourney("j3", "2026-03-01"),
    inferenceJourney("j4", "2026-04-01"),
  ];
}

describe("the persisted answer to a Home Base suggestion", () => {
  it("round-trips a stored digest back into the inference core as dismissed", async () => {
    const atlas = await freshAtlas("dismissal");
    const original = shenzhenFour();
    const suggested = inferHomeBaseCandidate({
      journeys: original,
      evaluationDate: "2026-04-02",
    });
    expect(suggested.state).toBe("suggested");
    expect(suggested.evidenceDigest).toBeTruthy();

    expect(await readHomeBaseDismissalForAtlas(atlas)).toBeNull();
    expect(await recordHomeBaseDismissalForAtlas(atlas, {
      kind: "soft",
      digest: suggested.evidenceDigest!,
      dismissedOn: "2026-04-02",
    })).toEqual({ kind: "soft", digest: suggested.evidenceDigest, dismissedAt: "2026-04-02" });

    const persisted = await readHomeBaseDismissalForAtlas(atlas);
    // Byte-exact: the core parses the anchor and the supporting Journey ids
    // back out of this string, so any storage-layer normalisation would
    // silently disarm the re-prompt rule below.
    expect(persisted?.digest).toBe(suggested.evidenceDigest);

    expect(inferHomeBaseCandidate({
      journeys: original,
      evaluationDate: "2026-08-01",
      dismissal: persisted,
    }).state).toBe("dismissed");
  });

  it("re-reaches the suggestion only when both 90 days and two further Journeys exist", async () => {
    const atlas = await freshAtlas("reprompt");
    const original = shenzhenFour();
    const suggested = inferHomeBaseCandidate({
      journeys: original,
      evaluationDate: "2026-04-02",
    });
    await recordHomeBaseDismissalForAtlas(atlas, {
      kind: "soft",
      digest: suggested.evidenceDigest!,
      dismissedOn: "2026-04-02",
    });
    const persisted = await readHomeBaseDismissalForAtlas(atlas);
    const expanded = [
      ...original,
      inferenceJourney("j5", "2026-04-15"),
      inferenceJourney("j6", "2026-05-01"),
    ];

    // Elapsed time alone is not materially new residence evidence.
    expect(inferHomeBaseCandidate({
      journeys: original,
      evaluationDate: "2026-08-01",
      dismissal: persisted,
    }).state).toBe("dismissed");

    // Two further supporting Journeys alone, inside the 90 days, are not either.
    expect(inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-05-15",
      dismissal: persisted,
    }).state).toBe("dismissed");

    // Both halves together, and only then.
    expect(inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-07-01",
      dismissal: persisted,
    }).state).toBe("suggested");
  });

  it("respects an explicit rejection more strongly than an ordinary not-now", async () => {
    const atlas = await freshAtlas("rejection");
    const original = shenzhenFour();
    const suggested = inferHomeBaseCandidate({
      journeys: original,
      evaluationDate: "2026-04-02",
    });
    await recordHomeBaseDismissalForAtlas(atlas, {
      kind: "rejected",
      digest: suggested.evidenceDigest!,
      dismissedOn: "2026-04-02",
    });
    const persisted = await readHomeBaseDismissalForAtlas(atlas);
    const expanded = [
      ...original,
      inferenceJourney("j5", "2026-04-15"),
      inferenceJourney("j6", "2026-05-01"),
    ];
    expect(inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-07-01",
      dismissal: persisted,
    }).state).toBe("dismissed");
  });

  it("keeps one atlas answer unreachable from another atlas", async () => {
    const mine = await freshAtlas("answer-mine");
    const theirs = await freshAtlas("answer-theirs");
    await recordHomeBaseDismissalForAtlas(mine, {
      kind: "soft",
      digest: "hbv1:22.5431:114.0579:1:2026-01-01:2026-01-01:j1=11:00000001",
      dismissedOn: "2026-04-02",
    });
    expect(await readHomeBaseDismissalForAtlas(theirs)).toBeNull();
  });
});

describe("confirming a move suggestion", () => {
  const moveResult: HomeBaseInferenceResult = {
    state: "move_suggested",
    metroAnchor: { latitude: 35.689487, longitude: 139.691711 },
    reasonCodes: ["DIFFERS_FROM_CONFIRMED_HOME"],
    evidenceDigest: "hbv1:35.6895:139.6917:4:2026-05-02:2026-08-18:t1=11,t2=11,t3=11,t4=11:0badf00d",
    support: {
      journeys: 4,
      starts: 4,
      ends: 4,
      runnerUpJourneys: 0,
      evidenceSpanDays: 108,
      evidenceStartedOn: "2026-05-02",
      evidenceEndedOn: "2026-08-18",
    },
    proposedPeriodStart: "2026-05-02",
  };

  it("closes the previous period at the proposed onset instead of overwriting it", async () => {
    const atlas = await freshAtlas("move");
    const shenzhen = await createHomeBasePeriodForAtlas(atlas, SHENZHEN);
    expect(shenzhen).toBeTruthy();

    const decision = resolveHomeBaseSuggestion({
      result: moveResult,
      placeLabel: "Tokyo",
      confirmedPlaceLabel: "Shenzhen",
    });
    const draft = homeBaseConfirmationDraft(decision, moveResult);
    expect(draft?.startedOn).toBe("2026-05-02");

    const tokyo = await createHomeBasePeriodForAtlas(atlas, draft!);
    expect(tokyo).toBeTruthy();

    const history = await listHomeBasePeriodsForAtlas(atlas);
    expect(history).toHaveLength(2);
    // The prior period survives with its own bounded dates: a move adds a
    // chapter and closes the old one on the onset day, it does not rewrite it.
    expect(history[0]).toMatchObject({
      id: shenzhen!.id,
      label: "Shenzhen",
      startedOn: "2022-06-01",
      endedOn: "2026-05-02",
    });
    expect(history[1]).toMatchObject({
      id: tokyo!.id,
      label: "Tokyo",
      startedOn: "2026-05-02",
      endedOn: null,
      source: "suggested-confirmed",
    });
    // And a Journey dated inside the old period still resolves to it.
    expect(resolveHomeBaseForDate(history, "2024-04-18")?.id).toBe(shenzhen!.id);
    expect(resolveHomeBaseForDate(history, "2026-09-01")?.id).toBe(tokyo!.id);
  });
});
