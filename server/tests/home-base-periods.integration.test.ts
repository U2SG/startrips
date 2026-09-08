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
  updateHomeBasePeriodForAtlas,
} from "../repositories/home-base-repository";
import { createJourneyForAtlas } from "../repositories/journey-repository";
import { resolveHomeBaseForDate } from "../../src/journey/homeBase";

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

  it("refuses to write a period for an atlas that is being deleted", async () => {
    const closing = await freshAtlas("closing");
    await db
      .update(atlases)
      .set({ deletionStartedAt: new Date() })
      .where(eq(atlases.id, closing));
    expect(await createHomeBasePeriodForAtlas(closing, SHENZHEN))
      .toBeUndefined();
  });
});
