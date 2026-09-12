import { describe, expect, it } from "vitest";
import {
  HOME_BASE_CLUSTER_RADIUS_KM,
  HOME_BASE_CANDIDATE_MIN_JOURNEYS,
  HOME_BASE_CANDIDATE_MIN_SPAN_DAYS,
  HOME_BASE_MIN_END_SUPPORT,
  HOME_BASE_MIN_LEAD_JOURNEYS,
  HOME_BASE_MIN_START_SUPPORT,
  HOME_BASE_SOFT_DISMISSAL_MIN_DAYS,
  HOME_BASE_SOFT_DISMISSAL_MIN_NEW_JOURNEYS,
  HOME_BASE_SUGGESTED_MIN_JOURNEYS,
  HOME_BASE_SUGGESTED_MIN_SPAN_DAYS,
  inferHomeBaseCandidate,
  type HomeBaseInferenceJourney,
} from "./homeBaseInference";
import { haversineDistanceKm } from "./mediaPlacement";

const SHENZHEN = { latitude: 22.5431, longitude: 114.0579 };
const GUANGZHOU = { latitude: 23.1291, longitude: 113.2644 };
const TOKYO = { latitude: 35.6762, longitude: 139.6503 };
const SINGAPORE = { latitude: 1.3521, longitude: 103.8198 };

type Coordinates = { latitude: number; longitude: number };

function journey(
  id: string,
  startedOn: string,
  start: Coordinates = SHENZHEN,
  end: Coordinates = SHENZHEN,
  endedOn: string | null = startedOn,
): HomeBaseInferenceJourney {
  return {
    id,
    startedOn,
    endedOn,
    routePoints: [
      {
        id: `${id}-start`,
        sortOrder: 0,
        latitude: start.latitude,
        longitude: start.longitude,
      },
      {
        id: `${id}-end`,
        sortOrder: 1,
        latitude: end.latitude,
        longitude: end.longitude,
      },
    ],
  };
}

function shenzhenFour(lastDate = "2026-04-01"): HomeBaseInferenceJourney[] {
  return [
    journey("j1", "2026-01-01"),
    journey("j2", "2026-02-01"),
    journey("j3", "2026-03-01"),
    journey("j4", lastDate),
  ];
}

function infer(journeys: readonly HomeBaseInferenceJourney[], evaluationDate = "2026-06-01") {
  return inferHomeBaseCandidate({ journeys, evaluationDate });
}

describe("Home Base V1 constants", () => {
  it("pins the owner-defined V1 thresholds", () => {
    expect(HOME_BASE_CLUSTER_RADIUS_KM).toBe(25);
    expect(HOME_BASE_CANDIDATE_MIN_JOURNEYS).toBe(3);
    expect(HOME_BASE_CANDIDATE_MIN_SPAN_DAYS).toBe(30);
    expect(HOME_BASE_SUGGESTED_MIN_JOURNEYS).toBe(4);
    expect(HOME_BASE_SUGGESTED_MIN_SPAN_DAYS).toBe(90);
    expect(HOME_BASE_MIN_START_SUPPORT).toBe(2);
    expect(HOME_BASE_MIN_END_SUPPORT).toBe(2);
    expect(HOME_BASE_MIN_LEAD_JOURNEYS).toBe(2);
    expect(HOME_BASE_SOFT_DISMISSAL_MIN_DAYS).toBe(90);
    expect(HOME_BASE_SOFT_DISMISSAL_MIN_NEW_JOURNEYS).toBe(2);
  });

  it("reuses mediaPlacement haversine distance for the 25 km region contract", () => {
    expect(haversineDistanceKm(SHENZHEN.latitude, SHENZHEN.longitude, SHENZHEN.latitude, SHENZHEN.longitude))
      .toBe(0);
  });
});

describe("inferHomeBaseCandidate thresholds", () => {
  it("keeps 2 Journeys insufficient and promotes 3 Journeys over 30 days to candidate", () => {
    const two = [journey("j1", "2026-01-01"), journey("j2", "2026-02-15")];
    expect(infer(two).state).toBe("insufficient_evidence");

    const three = [...two, journey("j3", "2026-03-15")];
    const result = infer(three);
    expect(result.state).toBe("candidate");
    expect(result.support.journeys).toBe(3);
  });

  it("keeps 3 Journeys at candidate and requires 4 Journeys over 90 days for suggested", () => {
    expect(infer(shenzhenFour().slice(0, 3)).state).toBe("candidate");
    expect(infer(shenzhenFour()).state).toBe("suggested");
  });

  it("treats an 89-day span as below suggested and a 90-day span as suggested", () => {
    expect(infer(shenzhenFour("2026-03-31")).support.evidenceSpanDays).toBe(89);
    expect(infer(shenzhenFour("2026-03-31")).state).toBe("candidate");
    expect(infer(shenzhenFour("2026-04-01")).support.evidenceSpanDays).toBe(90);
    expect(infer(shenzhenFour("2026-04-01")).state).toBe("suggested");
  });

  it("does not suggest with only one supporting start", () => {
    const journeys = [
      journey("j1", "2026-01-01", SHENZHEN, SHENZHEN),
      journey("j2", "2026-02-01", TOKYO, SHENZHEN),
      journey("j3", "2026-03-01", SINGAPORE, SHENZHEN),
      journey("j4", "2026-04-01", GUANGZHOU, SHENZHEN),
    ];
    const result = infer(journeys);
    expect(result.support.ends).toBe(4);
    expect(result.support.starts).toBe(1);
    expect(result.state).toBe("candidate");
  });

  it("does not suggest with only one supporting end", () => {
    const journeys = [
      journey("j1", "2026-01-01", SHENZHEN, SHENZHEN),
      journey("j2", "2026-02-01", SHENZHEN, TOKYO),
      journey("j3", "2026-03-01", SHENZHEN, SINGAPORE),
      journey("j4", "2026-04-01", SHENZHEN, GUANGZHOU),
    ];
    const result = infer(journeys);
    expect(result.support.starts).toBe(4);
    expect(result.support.ends).toBe(1);
    expect(result.state).toBe("candidate");
  });

  it("does not suggest when runner-up is within one Journey of the leader", () => {
    const journeys = [
      ...shenzhenFour(),
      journey("g1", "2026-01-05", GUANGZHOU, GUANGZHOU),
      journey("g2", "2026-02-05", GUANGZHOU, GUANGZHOU),
      journey("g3", "2026-03-05", GUANGZHOU, GUANGZHOU),
    ];
    const result = infer(journeys);
    expect(result.support.journeys).toBe(4);
    expect(result.support.runnerUpJourneys).toBe(3);
    expect(result.state).toBe("candidate");
  });

  it("counts one Journey with many media rows only once", () => {
    const noisy = shenzhenFour().map((item, index) => ({
      ...item,
      title: `title-${index}`,
      media: Array.from({ length: 100 }, (_, mediaIndex) => ({ id: `${item.id}-m${mediaIndex}` })),
    }));
    const result = inferHomeBaseCandidate({ journeys: noisy, evaluationDate: "2026-06-01" });
    expect(result.support.journeys).toBe(4);
    expect(result.state).toBe("suggested");
  });
});

describe("Home Base evidence fixtures", () => {
  it("suggests a repeated metro across 8 Journeys and several months", () => {
    const journeys = [
      journey("j1", "2025-10-01"),
      journey("j2", "2025-11-01"),
      journey("j3", "2025-12-01"),
      journey("j4", "2026-01-01"),
      journey("j5", "2026-02-01"),
      journey("j6", "2026-03-01"),
      journey("j7", "2026-04-01"),
      journey("j8", "2026-05-01"),
    ];
    const result = infer(journeys);
    expect(result.state).toBe("suggested");
    expect(result.support.journeys).toBe(8);
  });

  it("keeps a single holiday Journey insufficient", () => {
    expect(infer([journey("holiday", "2026-04-01")]).state).toBe("insufficient_evidence");
  });

  it("keeps sparse evidence split between two neighbouring metros insufficient", () => {
    const nearbyA = { latitude: 22.5431, longitude: 114.0579 };
    const nearbyB = { latitude: 22.5431, longitude: 114.37 };
    const journeys = [
      journey("a1", "2026-01-01", nearbyA, nearbyA),
      journey("a2", "2026-04-01", nearbyA, nearbyA),
      journey("b1", "2026-01-15", nearbyB, nearbyB),
      journey("b2", "2026-04-15", nearbyB, nearbyB),
    ];
    expect(infer(journeys).state).toBe("insufficient_evidence");
  });

  it("does not transitively chain coordinates that span beyond 25 km end-to-end", () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 0, longitude: 0.2 };
    const c = { latitude: 0, longitude: 0.4 };
    expect(haversineDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude)).toBeLessThan(25);
    expect(haversineDistanceKm(b.latitude, b.longitude, c.latitude, c.longitude)).toBeLessThan(25);
    expect(haversineDistanceKm(a.latitude, a.longitude, c.latitude, c.longitude)).toBeGreaterThan(25);

    const journeys = [
      journey("a1", "2026-01-01", a, a),
      journey("a2", "2026-02-01", a, a),
      journey("b1", "2026-03-01", b, b),
      journey("b2", "2026-04-01", b, b),
      journey("c1", "2026-05-01", c, c),
      journey("c2", "2026-06-01", c, c),
    ];
    const result = infer(journeys);
    expect(result.support.journeys).toBeLessThan(6);
    expect(result.state).not.toBe("suggested");
  });

  it("returns move_suggested with a proposed start and never mutates the confirmed period", () => {
    const confirmed = {
      startedOn: "2022-06-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const before = structuredClone(confirmed);
    const tokyoJourneys = shenzhenFour().map((item) => journey(
      item.id,
      item.startedOn,
      TOKYO,
      TOKYO,
      item.endedOn,
    ));
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2026-01-01");
    expect(confirmed).toEqual(before);
  });

  it("is deeply deterministic for identical input", () => {
    const input = { journeys: shenzhenFour(), evaluationDate: "2026-06-01" } as const;
    expect(inferHomeBaseCandidate(input)).toEqual(inferHomeBaseCandidate(input));
  });

  it("never returns confirmed even for the strongest fixture", () => {
    const states = [infer([
      ...shenzhenFour(),
      journey("j5", "2026-05-01"),
      journey("j6", "2026-06-01"),
      journey("j7", "2026-07-01"),
      journey("j8", "2026-08-01"),
    ]).state];
    expect(states).toEqual(["suggested"]);
    expect(states).not.toContain("confirmed");
  });
});

describe("dismissal and evidence digest", () => {
  it("keeps the digest stable across title, array reordering and unrelated media edits", () => {
    const base = shenzhenFour();
    const baseline = infer(base).evidenceDigest;
    const decorated = base.map((item, index) => ({
      ...item,
      title: `renamed-${index}`,
      media: [{ id: `unrelated-${index}` }],
      routePoints: [...item.routePoints].reverse(),
    }));
    expect(inferHomeBaseCandidate({ journeys: decorated, evaluationDate: "2026-06-01" }).evidenceDigest)
      .toBe(baseline);
  });

  it("keeps a matching soft dismissal dismissed", () => {
    const base = infer(shenzhenFour(), "2026-04-02");
    const dismissed = inferHomeBaseCandidate({
      journeys: shenzhenFour(),
      evaluationDate: "2026-08-01",
      dismissal: { kind: "soft", digest: base.evidenceDigest!, dismissedAt: "2026-04-02" },
    });
    expect(dismissed.state).toBe("dismissed");
  });

  it("does not reprompt on elapsed time alone", () => {
    const original = shenzhenFour();
    const base = infer(original, "2026-04-02");
    const result = inferHomeBaseCandidate({
      journeys: original,
      evaluationDate: "2026-08-01",
      dismissal: { kind: "soft", digest: base.evidenceDigest!, dismissedAt: "2026-04-02" },
    });
    expect(result.state).toBe("dismissed");
  });

  it("does not reprompt on two new supporting Journeys before 90 days", () => {
    const original = shenzhenFour();
    const base = infer(original, "2026-04-02");
    const expanded = [...original, journey("j5", "2026-04-15"), journey("j6", "2026-05-01")];
    const result = inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-05-15",
      dismissal: { kind: "soft", digest: base.evidenceDigest!, dismissedAt: "2026-04-02" },
    });
    expect(result.state).toBe("dismissed");
  });

  it("reprompts only after both 90 days and two new supporting Journeys", () => {
    const original = shenzhenFour();
    const base = infer(original, "2026-04-02");
    const expanded = [...original, journey("j5", "2026-04-15"), journey("j6", "2026-05-01")];
    const result = inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-07-01",
      dismissal: { kind: "soft", digest: base.evidenceDigest!, dismissedAt: "2026-04-02" },
    });
    expect(result.state).toBe("suggested");
  });

  it("respects an explicit rejection more strongly under the same changed evidence", () => {
    const original = shenzhenFour();
    const base = infer(original, "2026-04-02");
    const expanded = [...original, journey("j5", "2026-04-15"), journey("j6", "2026-05-01")];
    const result = inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-07-01",
      dismissal: { kind: "rejected", digest: base.evidenceDigest!, dismissedAt: "2026-04-02" },
    });
    expect(result.state).toBe("dismissed");
  });
});
