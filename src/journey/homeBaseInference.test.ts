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
const PARIS = { latitude: 48.8566, longitude: 2.3522 };

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

  it("preserves valid 00xx persisted calendar years in span arithmetic", () => {
    const ancient = [
      journey("j1", "0099-01-01"),
      journey("j2", "0099-02-01"),
      journey("j3", "0099-03-01"),
      journey("j4", "0099-04-01"),
    ];
    const result = infer(ancient, "0099-06-01");
    expect(result.support.evidenceSpanDays).toBe(90);
    expect(result.state).toBe("suggested");
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

  it("does not count a one-point Journey as both start and end evidence", () => {
    const locationOnly = shenzhenFour().map((item) => ({
      ...item,
      routePoints: [item.routePoints[0]],
    }));
    const result = infer(locationOnly);
    expect(result.support.journeys).toBe(4);
    expect(result.support.starts).toBe(4);
    expect(result.support.ends).toBe(0);
    expect(result.state).toBe("candidate");
  });

  it("does not invent end evidence when the Journey end date is unknown", () => {
    const openEnded = [
      journey("j1", "2026-01-01", SHENZHEN, SHENZHEN, null),
      journey("j2", "2026-02-01", SHENZHEN, SHENZHEN, null),
      journey("j3", "2026-03-01", SHENZHEN, SHENZHEN, null),
      journey("j4", "2026-04-01", SHENZHEN, SHENZHEN, null),
    ];
    const result = infer(openEnded);
    expect(result.support.journeys).toBe(4);
    expect(result.support.starts).toBe(4);
    expect(result.support.ends).toBe(0);
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

  it("prefers a threshold-qualified candidate over a larger same-day cluster", () => {
    const concentrated = [
      journey("tokyo-1", "2026-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2026-01-01", TOKYO, TOKYO),
      journey("tokyo-3", "2026-01-01", TOKYO, TOKYO),
      journey("tokyo-4", "2026-01-01", TOKYO, TOKYO),
    ];
    const qualified = [
      journey("singapore-1", "2026-01-01", SINGAPORE, SINGAPORE),
      journey("singapore-2", "2026-02-01", SINGAPORE, SINGAPORE),
      journey("singapore-3", "2026-03-05", SINGAPORE, SINGAPORE),
    ];
    const result = infer([...concentrated, ...qualified]);
    expect(result.state).toBe("candidate");
    expect(result.support.journeys).toBe(3);
    expect(result.metroAnchor).not.toBeNull();
    expect(haversineDistanceKm(
      result.metroAnchor!.latitude,
      result.metroAnchor!.longitude,
      SINGAPORE.latitude,
      SINGAPORE.longitude,
    )).toBeLessThanOrEqual(HOME_BASE_CLUSTER_RADIUS_KM);
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
    expect(result.support.journeys).toBe(4);
    expect(result.support.journeys).toBeLessThan(6);
    expect(result.support.runnerUpJourneys).toBe(2);
  });

  it("prefers balanced directional support when tied bounded regions cover the same Journeys", () => {
    const atKm = (kilometers: number): Coordinates => ({ latitude: kilometers / 111.2, longitude: 0 });
    const journeys = [
      journey("j1", "2026-01-01", atKm(0), atKm(-10)),
      journey("j2", "2026-02-01", atKm(0), atKm(100)),
      journey("j3", "2026-03-01", atKm(-20), atKm(20)),
      journey("j4", "2026-04-02", atKm(-20), atKm(20)),
    ];
    const result = infer(journeys, "2026-06-01");
    expect(result.support.journeys).toBe(4);
    expect(result.support.starts).toBe(2);
    expect(result.support.ends).toBe(2);
    expect(result.state).toBe("suggested");
  });

  it("prefers directionally eligible bounded support over a larger start-heavy neighbour", () => {
    const atKm = (kilometers: number): Coordinates => ({ latitude: kilometers / 111.2, longitude: 0 });
    const journeys = [
      journey("j1", "2026-01-01", atKm(0), atKm(-10)),
      journey("j2", "2026-02-01", atKm(0), atKm(100)),
      journey("j3", "2026-03-01", atKm(-20), atKm(20)),
      journey("j4", "2026-04-02", atKm(-20), atKm(20)),
      journey("j5", "2026-05-02", atKm(-20), atKm(100)),
    ];
    const result = infer(journeys, "2026-06-01");
    expect(result.support.journeys).toBe(4);
    expect(result.support.starts).toBe(2);
    expect(result.support.ends).toBe(2);
    expect(result.support.runnerUpJourneys).toBe(2);
    expect(result.state).toBe("suggested");
  });
  it("handles a dense bounded metro without changing Journey support semantics", () => {
    const dense = Array.from({ length: 120 }, (_value, index) =>
      journey(`dense-${index}`, `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`));
    const result = infer(dense, "2026-12-31");
    expect(result.support.journeys).toBe(120);
    expect(result.support.starts).toBe(120);
    expect(result.support.ends).toBe(120);
    expect(result.state).toBe("suggested");
  });

  it("finds the strongest bounded region when nearer incompatible endpoints would fool greedy admission", () => {
    const validA = { latitude: 0, longitude: 0 };
    const validB = { latitude: 0, longitude: 0.06 };
    const validC = { latitude: 0, longitude: 0.12 };
    const validD = { latitude: 0, longitude: 0.18 };
    const spoilerA = { latitude: 0, longitude: -0.1 };
    const spoilerB = { latitude: 0, longitude: -0.05 };
    const spoilerC = { latitude: 0, longitude: 0.23 };
    const spoilerD = { latitude: 0, longitude: 0.28 };
    expect(haversineDistanceKm(validA.latitude, validA.longitude, validD.latitude, validD.longitude))
      .toBeLessThan(25);
    expect(haversineDistanceKm(spoilerB.latitude, spoilerB.longitude, validD.latitude, validD.longitude))
      .toBeGreaterThan(25);

    const journeys = [
      journey("j1", "2026-01-01", validA, spoilerA),
      journey("j2", "2026-02-01", validB, spoilerB),
      journey("j3", "2026-03-01", spoilerC, validC),
      journey("j4", "2026-04-01", spoilerD, validD),
    ];
    const result = infer(journeys);
    expect(result.support.journeys).toBe(4);
    expect(result.support.starts).toBe(2);
    expect(result.support.ends).toBe(2);
    expect(result.state).toBe("suggested");
  });

  it("ignores evidence older than the active confirmed period when evaluating a move", () => {
    const confirmed = {
      startedOn: "2026-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const oldTokyo = Array.from({ length: 8 }, (_value, index) => journey(
      `old-${index}`,
      `2025-${String(index + 1).padStart(2, "0")}-01`,
      TOKYO,
      TOKYO,
    ));
    const result = inferHomeBaseCandidate({
      journeys: [...oldTokyo, ...shenzhenFour(), journey("j5", "2026-05-02")],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("candidate");
    expect(result.reasonCodes).toContain("MATCHES_CONFIRMED_HOME");
    expect(result.support.evidenceStartedOn).toBe("2026-02-01");
    expect(result.proposedPeriodStart).toBeNull();
  });

  it("starts a move at the sustained evidence window instead of an isolated old visit", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyoJourneys = [
      journey("old-holiday", "2023-06-01", TOKYO, TOKYO),
      journey("j1", "2026-01-01", TOKYO, TOKYO),
      journey("j2", "2026-02-01", TOKYO, TOKYO),
      journey("j3", "2026-03-01", TOKYO, TOKYO),
      journey("j4", "2026-04-02", TOKYO, TOKYO),
    ];
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.support.evidenceStartedOn).toBe("2026-01-01");
    expect(result.proposedPeriodStart).toBe("2026-01-01");
  });

  it("keeps the earliest qualifying sustained move date when later suffixes also qualify", () => {
    const confirmed = {
      startedOn: "2025-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyoJourneys = Array.from({ length: 8 }, (_value, index) => {
      const month = String(index + 1).padStart(2, "0");
      return journey(`tokyo-${index + 1}`, `2026-${month}-01`, TOKYO, TOKYO);
    });
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: confirmed,
      evaluationDate: "2026-09-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2026-01-01");
  });

  it("keeps dense move inference bounded while reusing the initial region search", () => {
    const confirmed = {
      startedOn: "2010-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const dense = Array.from({ length: 120 }, (_value, index) => {
      const year = 2016 + Math.floor(index / 12);
      const month = String((index % 12) + 1).padStart(2, "0");
      return journey(`dense-move-${index}`, `${year}-${month}-01`, TOKYO, TOKYO);
    });
    const result = inferHomeBaseCandidate({
      journeys: dense,
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2016-01-01");
  });

  it("detects a sustained new Home even while the confirmed Home remains the all-history leader", () => {
    const confirmed = {
      startedOn: "2025-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const establishedHome = Array.from({ length: 10 }, (_value, index) => {
      const month = String(index + 2).padStart(2, "0");
      return journey(`shenzhen-${index + 1}`, `2025-${month}-01`, SHENZHEN, SHENZHEN);
    });
    const movedHome = [
      journey("tokyo-1", "2026-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2026-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2026-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2026-04-02", TOKYO, TOKYO),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...establishedHome, ...movedHome],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.support.journeys).toBe(4);
    expect(result.proposedPeriodStart).toBe("2026-01-01");
    expect(result.proposedPeriodStart).toBe(result.support.evidenceStartedOn);
    expect(haversineDistanceKm(
      result.metroAnchor!.latitude,
      result.metroAnchor!.longitude,
      TOKYO.latitude,
      TOKYO.longitude,
    )).toBeLessThanOrEqual(HOME_BASE_CLUSTER_RADIUS_KM);
  });

  it("retains an earlier qualifying move block after a later isolated visit", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const result = inferHomeBaseCandidate({
      journeys: [
        journey("tokyo-1", "2023-01-01", TOKYO, TOKYO),
        journey("tokyo-2", "2023-02-01", TOKYO, TOKYO),
        journey("tokyo-3", "2023-03-01", TOKYO, TOKYO),
        journey("tokyo-4", "2023-04-02", TOKYO, TOKYO),
        journey("late-visit", "2026-05-01", TOKYO, TOKYO),
      ],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2023-01-01");
  });

  it("keeps sparse long-term repeated move evidence without a maximum-gap rule", () => {
    const confirmed = {
      startedOn: "2024-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const result = inferHomeBaseCandidate({
      journeys: [
        journey("tokyo-1", "2025-01-01", TOKYO, TOKYO),
        journey("tokyo-2", "2025-04-15", TOKYO, TOKYO),
        journey("tokyo-3", "2025-08-20", TOKYO, TOKYO),
        journey("tokyo-4", "2025-12-31", TOKYO, TOKYO),
      ],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-01-15",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2025-01-01");
  });

  it("ignores an expired competing window when later move evidence stays unambiguous", () => {
    const confirmed = {
      startedOn: "2024-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyo = Array.from({ length: 12 }, (_value, index) => {
      const month = String(index + 1).padStart(2, "0");
      return journey(`tokyo-${index + 1}`, `2025-${month}-01`, TOKYO, TOKYO);
    });
    const earlyCompetition = [
      journey("singapore-1", "2025-02-01", SINGAPORE, SINGAPORE),
      journey("singapore-2", "2025-03-01", SINGAPORE, SINGAPORE),
      journey("singapore-3", "2025-04-02", SINGAPORE, SINGAPORE),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...tokyo, ...earlyCompetition],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-01-15",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2025-01-01");
    expect(result.metroAnchor).not.toBeNull();
    expect(haversineDistanceKm(
      result.metroAnchor!.latitude,
      result.metroAnchor!.longitude,
      TOKYO.latitude,
      TOKYO.longitude,
    )).toBeLessThanOrEqual(HOME_BASE_CLUSTER_RADIUS_KM);
  });

  it("lets newer candidate-strength evidence at the move metro retire older competition", () => {
    const confirmed = {
      startedOn: "2024-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const establishedMove = [
      journey("tokyo-1", "2025-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2025-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2025-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2025-04-02", TOKYO, TOKYO),
      journey("tokyo-5", "2025-05-02", TOKYO, TOKYO),
      journey("tokyo-6", "2025-06-02", TOKYO, TOKYO),
    ];
    const expiredCompetition = [
      journey("singapore-1", "2025-02-15", SINGAPORE, SINGAPORE),
      journey("singapore-2", "2025-03-15", SINGAPORE, SINGAPORE),
      journey("singapore-3", "2025-04-16", SINGAPORE, SINGAPORE),
    ];
    const renewedMoveEvidence = [
      journey("tokyo-7", "2025-07-01", TOKYO, TOKYO),
      journey("tokyo-8", "2026-06-01", TOKYO, TOKYO),
      journey("tokyo-9", "2026-12-31", TOKYO, TOKYO),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...establishedMove, ...expiredCompetition, ...renewedMoveEvidence],
      confirmedPeriod: confirmed,
      evaluationDate: "2027-01-15",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.metroAnchor).not.toBeNull();
    expect(haversineDistanceKm(
      result.metroAnchor!.latitude,
      result.metroAnchor!.longitude,
      TOKYO.latitude,
      TOKYO.longitude,
    )).toBeLessThanOrEqual(HOME_BASE_CLUSTER_RADIUS_KM);
  });
  it("keeps a competitor current when it reaches candidate strength after the move metro", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const oldMove = [
      journey("old-tokyo-1", "2023-01-01", TOKYO, TOKYO),
      journey("old-tokyo-2", "2023-02-01", TOKYO, TOKYO),
      journey("old-tokyo-3", "2023-03-01", TOKYO, TOKYO),
      journey("old-tokyo-4", "2023-04-02", TOKYO, TOKYO),
    ];
    const newerTokyo = [
      journey("new-tokyo-1", "2025-02-01", TOKYO, TOKYO),
      journey("new-tokyo-2", "2025-03-01", TOKYO, TOKYO),
      journey("new-tokyo-3", "2025-04-02", TOKYO, TOKYO),
    ];
    const laterCompetition = [
      journey("singapore-1", "2025-01-01", SINGAPORE, SINGAPORE),
      journey("singapore-2", "2025-03-15", SINGAPORE, SINGAPORE),
      journey("singapore-3", "2025-05-01", SINGAPORE, SINGAPORE),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...oldMove, ...newerTokyo, ...laterCompetition],
      confirmedPeriod: confirmed,
      evaluationDate: "2025-06-01",
    });
    expect(result.state).toBe("candidate");
    expect(result.proposedPeriodStart).toBeNull();
  });
  it("does not let an unrelated weak region resurrect expired move competition", () => {
    const confirmed = {
      startedOn: "2024-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyo = [
      journey("tokyo-1", "2025-09-01", TOKYO, TOKYO),
      journey("tokyo-2", "2025-10-01", TOKYO, TOKYO),
      journey("tokyo-3", "2025-11-01", TOKYO, TOKYO),
      journey("tokyo-4", "2025-12-02", TOKYO, TOKYO),
    ];
    const expiredCompetition = [
      journey("singapore-1", "2025-02-01", SINGAPORE, SINGAPORE),
      journey("singapore-2", "2025-03-01", SINGAPORE, SINGAPORE),
      journey("singapore-3", "2025-04-02", SINGAPORE, SINGAPORE),
    ];
    const weakUnrelated = [
      journey("paris-1", "2025-01-01", PARIS, PARIS),
      journey("paris-2", "2025-12-02", PARIS, PARIS),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...tokyo, ...expiredCompetition, ...weakUnrelated],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-01-15",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2025-09-01");
    expect(result.metroAnchor).not.toBeNull();
    expect(haversineDistanceKm(
      result.metroAnchor!.latitude,
      result.metroAnchor!.longitude,
      TOKYO.latitude,
      TOKYO.longitude,
    )).toBeLessThanOrEqual(HOME_BASE_CLUSTER_RADIUS_KM);
  });

  it("retires a historical move when later candidate-strength evidence is ambiguous", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const oldAway = [
      journey("tokyo-1", "2023-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2023-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2023-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2023-04-02", TOKYO, TOKYO),
    ];
    const laterHome = [
      journey("home-1", "2025-01-01", SHENZHEN, SHENZHEN),
      journey("home-2", "2025-02-01", SHENZHEN, SHENZHEN),
      journey("home-3", "2025-03-01", SHENZHEN, SHENZHEN),
      journey("home-4", "2025-04-02", SHENZHEN, SHENZHEN),
    ];
    const competing = [
      journey("singapore-1", "2025-01-15", SINGAPORE, SINGAPORE),
      journey("singapore-2", "2025-02-15", SINGAPORE, SINGAPORE),
      journey("singapore-3", "2025-04-15", SINGAPORE, SINGAPORE),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...oldAway, ...laterHome, ...competing],
      confirmedPeriod: confirmed,
      evaluationDate: "2025-06-01",
    });
    expect(result.state).toBe("candidate");
    expect(result.proposedPeriodStart).toBeNull();
    expect(result.reasonCodes).toContain("MATCHES_CONFIRMED_HOME");
  });

  it("does not keep an obsolete away move after a later sustained return Home", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const oldAway = [
      journey("tokyo-1", "2023-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2023-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2023-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2023-04-02", TOKYO, TOKYO),
    ];
    const returnedHome = Array.from({ length: 8 }, (_value, index) => {
      const month = String(index + 1).padStart(2, "0");
      return journey(`home-${index + 1}`, `2025-${month}-01`, SHENZHEN, SHENZHEN);
    });
    const result = inferHomeBaseCandidate({
      journeys: [...oldAway, ...returnedHome],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-01-01",
    });
    expect(result.state).toBe("candidate");
    expect(result.proposedPeriodStart).toBeNull();
    expect(result.reasonCodes).toContain("MATCHES_CONFIRMED_HOME");
  });

  it("does not let one isolated revisit refresh a move retired by a later Home state", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const oldAway = [
      journey("tokyo-1", "2023-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2023-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2023-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2023-04-02", TOKYO, TOKYO),
    ];
    const returnedHome = [
      journey("home-1", "2025-01-01", SHENZHEN, SHENZHEN),
      journey("home-2", "2025-03-01", SHENZHEN, SHENZHEN),
      journey("home-3", "2025-04-15", SHENZHEN, SHENZHEN),
    ];
    const isolatedRevisit = journey("tokyo-revisit", "2026-05-01", TOKYO, TOKYO);
    const result = inferHomeBaseCandidate({
      journeys: [...oldAway, ...returnedHome, isolatedRevisit],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("candidate");
    expect(result.proposedPeriodStart).toBeNull();
  });

  it("does not let one late Home revisit suppress a newer sustained move", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const oldHome = Array.from({ length: 8 }, (_value, index) => {
      const month = String(index + 1).padStart(2, "0");
      return journey(`old-home-${index + 1}`, `2023-${month}-01`, SHENZHEN, SHENZHEN);
    });
    const sustainedMove = [
      journey("tokyo-1", "2025-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2025-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2025-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2025-04-02", TOKYO, TOKYO),
    ];
    const isolatedHomeRevisit = journey("home-revisit", "2026-05-01", SHENZHEN, SHENZHEN);
    const result = inferHomeBaseCandidate({
      journeys: [...oldHome, ...sustainedMove, isolatedHomeRevisit],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.proposedPeriodStart).toBe("2025-01-01");
    expect(result.metroAnchor).not.toBeNull();
    expect(haversineDistanceKm(
      result.metroAnchor!.latitude,
      result.metroAnchor!.longitude,
      TOKYO.latitude,
      TOKYO.longitude,
    )).toBeLessThanOrEqual(HOME_BASE_CLUSTER_RADIUS_KM);
  });

  it("does not let one old holiday turn three recent Journeys into a sustained move", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyoJourneys = [
      journey("old-holiday", "2023-06-01", TOKYO, TOKYO),
      journey("j1", "2026-01-01", TOKYO, TOKYO),
      journey("j2", "2026-02-15", TOKYO, TOKYO),
      journey("j3", "2026-04-02", TOKYO, TOKYO),
    ];
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.support.journeys).toBe(4);
    expect(result.state).toBe("candidate");
    expect(result.proposedPeriodStart).toBeNull();
  });

  it("rechecks runner-up competition inside the sustained move window", () => {
    const confirmed = {
      startedOn: "2022-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const target = [
      journey("old-holiday", "2023-06-01", TOKYO, TOKYO),
      journey("tokyo-1", "2026-01-01", TOKYO, TOKYO),
      journey("tokyo-2", "2026-02-01", TOKYO, TOKYO),
      journey("tokyo-3", "2026-03-01", TOKYO, TOKYO),
      journey("tokyo-4", "2026-04-02", TOKYO, TOKYO),
    ];
    const runnerUp = [
      journey("runner-1", "2026-01-15", SINGAPORE, SINGAPORE),
      journey("runner-2", "2026-02-15", SINGAPORE, SINGAPORE),
      journey("runner-3", "2026-03-15", SINGAPORE, SINGAPORE),
    ];
    const result = inferHomeBaseCandidate({
      journeys: [...target, ...runnerUp],
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.support.journeys).toBe(5);
    expect(result.support.runnerUpJourneys).toBe(3);
    expect(result.state).toBe("candidate");
    expect(result.proposedPeriodStart).toBeNull();
  });

  it("never proposes a move on the current confirmed period start date", () => {
    const confirmed = {
      startedOn: "2026-01-01",
      endedOn: null,
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyoJourneys = [
      journey("same-day", "2026-01-01", TOKYO, TOKYO),
      journey("j2", "2026-02-01", TOKYO, TOKYO),
      journey("j3", "2026-03-01", TOKYO, TOKYO),
      journey("j4", "2026-04-01", TOKYO, TOKYO),
      journey("j5", "2026-05-02", TOKYO, TOKYO),
    ];
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: confirmed,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("move_suggested");
    expect(result.support.evidenceStartedOn).toBe("2026-02-01");
    expect(result.proposedPeriodStart).toBe("2026-02-01");
  });

  it("does not treat a confirmed period that already ended as the current Home", () => {
    const historical = {
      startedOn: "2022-06-01",
      endedOn: "2025-01-01",
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyoJourneys = shenzhenFour().map((item) => journey(
      item.id,
      item.startedOn,
      TOKYO,
      TOKYO,
      item.endedOn,
    ));
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: historical,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("suggested");
    expect(result.proposedPeriodStart).toBeNull();
  });

  it("does not propose an open move from a bounded confirmed period", () => {
    const bounded = {
      startedOn: "2022-06-01",
      endedOn: "2026-12-31",
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
    } as const;
    const tokyoJourneys = shenzhenFour().map((item) => journey(
      item.id,
      item.startedOn,
      TOKYO,
      TOKYO,
      item.endedOn,
    ));
    const result = inferHomeBaseCandidate({
      journeys: tokyoJourneys,
      confirmedPeriod: bounded,
      evaluationDate: "2026-06-01",
    });
    expect(result.state).toBe("suggested");
    expect(result.proposedPeriodStart).toBeNull();
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

  it("accepts an ISO timestamp when measuring soft-dismissal elapsed days", () => {
    const original = shenzhenFour();
    const base = infer(original, "2026-04-02");
    const expanded = [...original, journey("j5", "2026-04-15"), journey("j6", "2026-05-01")];
    const result = inferHomeBaseCandidate({
      journeys: expanded,
      evaluationDate: "2026-07-02",
      dismissal: {
        kind: "soft",
        digest: base.evidenceDigest!,
        dismissedAt: "2026-04-02T10:00:00.000Z",
      },
    });
    expect(result.state).toBe("suggested");
  });

  it("counts new supporting Journey IDs even when old support is replaced", () => {
    const original = shenzhenFour();
    const base = infer(original, "2026-04-02");
    const replacement = [
      original[2],
      original[3],
      journey("j5", "2026-05-01"),
      journey("j6", "2026-06-01"),
    ];
    const result = inferHomeBaseCandidate({
      journeys: replacement,
      evaluationDate: "2026-08-01",
      dismissal: { kind: "soft", digest: base.evidenceDigest!, dismissedAt: "2026-04-02" },
    });
    expect(result.support.journeys).toBe(4);
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
