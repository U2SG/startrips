import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { atlases, homeBasePeriods } from "../db/app-schema";
import { db, pool } from "../db/client";
import {
  createHomeBasePeriodForAtlas,
  deleteHomeBasePeriodForAtlas,
  HomeBasePeriodConflictError,
  listHomeBasePeriodsForAtlas,
  updateHomeBasePeriodForAtlas,
  type HomeBasePeriodValues,
} from "./home-base-repository";

/**
 * #231: the write invariants, against the real PostgreSQL the `core` CI lane
 * provisions. The Atlas rows are inserted directly rather than through the
 * API: nothing here needs a session, because the repository takes the Atlas id
 * it is given and every authorization assertion lives in the route and
 * integration files.
 */

const atlasIds: string[] = [];

const SHENZHEN: HomeBasePeriodValues = {
  label: "Shenzhen",
  latitude: 22.543096,
  longitude: 114.057865,
  startedOn: "2022-06-01",
  endedOn: null,
  source: "manual",
};
const TOKYO: HomeBasePeriodValues = {
  label: "Tokyo",
  latitude: 35.689487,
  longitude: 139.691711,
  startedOn: "2026-09-01",
  endedOn: null,
  source: "suggested-confirmed",
};

async function freshAtlas(label: string): Promise<string> {
  const [atlas] = await db
    .insert(atlases)
    .values({
      organizationId: `test-org-home-base-${label}-${randomUUID()}`,
      title: `${label} Atlas`,
    })
    .returning({ id: atlases.id });
  atlasIds.push(atlas.id);
  return atlas.id;
}

/** The rows as PostgreSQL holds them, bypassing every repository read path. */
async function storedPeriods(atlasId: string) {
  return await db
    .select({
      id: homeBasePeriods.id,
      label: homeBasePeriods.label,
      startedOn: homeBasePeriods.startedOn,
      endedOn: homeBasePeriods.endedOn,
    })
    .from(homeBasePeriods)
    .where(eq(homeBasePeriods.atlasId, atlasId))
    .orderBy(asc(homeBasePeriods.startedOn), asc(homeBasePeriods.id));
}

let atlasId = "";

beforeAll(async () => {
  atlasId = await freshAtlas("primary");
});

afterAll(async () => {
  if (atlasIds.length > 0) {
    await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  }
  await pool.end();
});

describe("recording a move", () => {
  it("closes the previously open period and opens the new one in one transaction", async () => {
    const moveAtlas = await freshAtlas("move");
    const first = await createHomeBasePeriodForAtlas(moveAtlas, SHENZHEN);
    expect(first?.endedOn).toBeNull();

    const second = await createHomeBasePeriodForAtlas(moveAtlas, TOKYO);
    expect(second?.startedOn).toBe("2026-09-01");
    expect(second?.endedOn).toBeNull();
    expect(second?.source).toBe("suggested-confirmed");

    // Both writes are visible together: the old period is closed on exactly
    // the day the new one starts, so no reader sees two current Homes, none,
    // or a gap.
    expect(await storedPeriods(moveAtlas)).toEqual([
      {
        id: first!.id,
        label: "Shenzhen",
        startedOn: "2022-06-01",
        endedOn: "2026-09-01",
      },
      {
        id: second!.id,
        label: "Tokyo",
        startedOn: "2026-09-01",
        endedOn: null,
      },
    ]);
  });

  it("keeps the closed period's own start, so earlier dates are untouched", async () => {
    const historyAtlas = await freshAtlas("history");
    const first = await createHomeBasePeriodForAtlas(historyAtlas, SHENZHEN);
    await createHomeBasePeriodForAtlas(historyAtlas, TOKYO);
    const periods = await listHomeBasePeriodsForAtlas(historyAtlas);
    expect(periods[0].id).toBe(first!.id);
    expect(periods[0].startedOn).toBe("2022-06-01");
    expect(periods.map((period) => period.label)).toEqual(["Shenzhen", "Tokyo"]);
  });
});

describe("impossible histories", () => {
  it("rejects a period that ends before it started", async () => {
    const rejectAtlas = await freshAtlas("reversed");
    await expect(createHomeBasePeriodForAtlas(rejectAtlas, {
      ...SHENZHEN,
      startedOn: "2026-09-01",
      endedOn: "2026-08-01",
    })).rejects.toBeInstanceOf(HomeBasePeriodConflictError);
    await expect(createHomeBasePeriodForAtlas(rejectAtlas, {
      ...SHENZHEN,
      startedOn: "2026-09-01",
      endedOn: "2026-08-01",
    })).rejects.toMatchObject({ code: "HOME_BASE_PERIOD_INVALID_INTERVAL" });
    expect(await storedPeriods(rejectAtlas)).toEqual([]);
  });

  it("rejects an overlapping confirmed primary period", async () => {
    const overlapAtlas = await freshAtlas("overlap");
    await createHomeBasePeriodForAtlas(overlapAtlas, {
      ...SHENZHEN,
      endedOn: "2026-09-01",
    });
    await expect(createHomeBasePeriodForAtlas(overlapAtlas, {
      ...TOKYO,
      startedOn: "2024-01-01",
      endedOn: "2025-01-01",
    })).rejects.toMatchObject({ code: "HOME_BASE_PERIOD_OVERLAP" });
    expect((await storedPeriods(overlapAtlas)).length).toBe(1);
  });

  it("rejects a second open-ended period that cannot be read as a move", async () => {
    const openAtlas = await freshAtlas("open");
    await createHomeBasePeriodForAtlas(openAtlas, SHENZHEN);
    // Same start day as the open period: closing it would leave an interval
    // covering no date, so this is a second current Home, not a move.
    await expect(createHomeBasePeriodForAtlas(openAtlas, {
      ...TOKYO,
      startedOn: SHENZHEN.startedOn,
    })).rejects.toMatchObject({ code: "HOME_BASE_PERIOD_ALREADY_OPEN" });
    expect((await storedPeriods(openAtlas)).length).toBe(1);
  });

  it("rejects an amend that would reopen a second current Home", async () => {
    const amendAtlas = await freshAtlas("amend");
    const first = await createHomeBasePeriodForAtlas(amendAtlas, SHENZHEN);
    await createHomeBasePeriodForAtlas(amendAtlas, TOKYO);
    // An amend never closes someone else's period, so clearing this one's end
    // is refused rather than silently ending Tokyo.
    await expect(updateHomeBasePeriodForAtlas(amendAtlas, first!.id, {
      endedOn: null,
    })).rejects.toMatchObject({ code: "HOME_BASE_PERIOD_ALREADY_OPEN" });
    expect((await storedPeriods(amendAtlas))[0].endedOn).toBe("2026-09-01");
  });

  it("carries a message alongside the code for the API envelope", async () => {
    const error = new HomeBasePeriodConflictError(
      "HOME_BASE_PERIOD_OVERLAP",
      "Another Home Base period already covers those dates",
    );
    expect(error.name).toBe("HomeBasePeriodConflictError");
    expect(error.message).toBeTruthy();
  });
});

describe("corrections and removal", () => {
  it("corrects a period's place and dates in place", async () => {
    const created = await createHomeBasePeriodForAtlas(atlasId, {
      ...SHENZHEN,
      startedOn: "2020-01-01",
      endedOn: "2021-01-01",
    });
    const updated = await updateHomeBasePeriodForAtlas(atlasId, created!.id, {
      label: "Guangzhou",
      startedOn: "2020-03-01",
    });
    expect(updated).toMatchObject({
      id: created!.id,
      label: "Guangzhou",
      startedOn: "2020-03-01",
      endedOn: "2021-01-01",
    });
  });

  it("answers nothing for a period the atlas does not own", async () => {
    const otherAtlas = await freshAtlas("other");
    const foreign = await createHomeBasePeriodForAtlas(otherAtlas, {
      ...SHENZHEN,
      startedOn: "2015-01-01",
      endedOn: "2016-01-01",
    });
    expect(await updateHomeBasePeriodForAtlas(atlasId, foreign!.id, {
      label: "Stolen",
    })).toBeUndefined();
    expect(await deleteHomeBasePeriodForAtlas(atlasId, foreign!.id))
      .toBeUndefined();
    // Still exactly as its own atlas left it.
    expect((await storedPeriods(otherAtlas))[0].label).toBe("Shenzhen");
  });

  it("removes one period and leaves the rest of the history standing", async () => {
    const trimAtlas = await freshAtlas("trim");
    const first = await createHomeBasePeriodForAtlas(trimAtlas, SHENZHEN);
    const second = await createHomeBasePeriodForAtlas(trimAtlas, TOKYO);
    expect(await deleteHomeBasePeriodForAtlas(trimAtlas, first!.id))
      .toEqual({ id: first!.id });
    expect((await storedPeriods(trimAtlas)).map((period) => period.id))
      .toEqual([second!.id]);
  });
});
