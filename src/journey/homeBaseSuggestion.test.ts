import { describe, expect, it } from "vitest";
import {
  HOME_BASE_EVIDENCE_REASON_CODES,
  HOME_BASE_EVIDENCE_REASON_COPY,
  homeBaseConfirmationDraft,
  resolveHomeBasePlaceLabel,
  resolveHomeBaseSuggestion,
} from "./homeBaseSuggestion";
import type {
  HomeBaseEvidenceReasonCode,
  HomeBaseInferenceResult,
  HomeBaseInferenceState,
} from "./homeBaseInference";

/**
 * #232, the surface half of Home Base inference. Everything here is pure, so
 * it runs in the default node environment of the `core` lane exactly like the
 * inference core's own fixtures; no DOM, no jsdom environment, no rendering.
 */

/**
 * Every reason code the core exports, written out by hand.
 *
 * `satisfies` rejects a code that is not in the union, and `Missing` rejects a
 * code of the union that is missing here — both directions, so this list
 * cannot silently drift from the core it is supposed to be total over.
 */
const EVERY_REASON_CODE = [
  "NO_ROUTE_ENDPOINT_EVIDENCE",
  "CANDIDATE_JOURNEY_THRESHOLD_MET",
  "CANDIDATE_SPAN_THRESHOLD_MET",
  "SUGGESTED_JOURNEY_THRESHOLD_MET",
  "SUGGESTED_SPAN_THRESHOLD_MET",
  "START_SUPPORT_THRESHOLD_MET",
  "END_SUPPORT_THRESHOLD_MET",
  "LEADER_MARGIN_THRESHOLD_MET",
  "MATCHES_CONFIRMED_HOME",
  "DIFFERS_FROM_CONFIRMED_HOME",
  "SOFT_DISMISSAL_ACTIVE",
  "REJECTED_DISMISSAL_ACTIVE",
] as const satisfies readonly HomeBaseEvidenceReasonCode[];

type MissingReasonCode = Exclude<
  HomeBaseEvidenceReasonCode,
  (typeof EVERY_REASON_CODE)[number]
>;
const NO_REASON_CODE_IS_MISSING: MissingReasonCode extends never ? true : false = true;

const ANCHOR = { latitude: 22.543096, longitude: 114.057865 };

function inferenceResult(
  state: HomeBaseInferenceState,
  overrides: Partial<HomeBaseInferenceResult> = {},
): HomeBaseInferenceResult {
  return {
    state,
    metroAnchor: ANCHOR,
    reasonCodes: ["SUGGESTED_JOURNEY_THRESHOLD_MET", "START_SUPPORT_THRESHOLD_MET"],
    evidenceDigest: "hbv1:22.5431:114.0579:4:2026-01-04:2026-08-18:a=11,b=10,c=01,d=11:1a2b3c4d",
    support: {
      journeys: 4,
      starts: 3,
      ends: 3,
      runnerUpJourneys: 1,
      evidenceSpanDays: 226,
      evidenceStartedOn: "2026-01-04",
      evidenceEndedOn: "2026-08-18",
    },
    proposedPeriodStart: null,
    ...overrides,
  };
}

describe("the reason-code copy mapping is total over the core's union", () => {
  it("gives every exported reason code one evidence sentence", () => {
    expect(NO_REASON_CODE_IS_MISSING).toBe(true);
    expect([...HOME_BASE_EVIDENCE_REASON_CODES].sort()).toEqual([...EVERY_REASON_CODE].sort());
    for (const code of EVERY_REASON_CODE) {
      expect(HOME_BASE_EVIDENCE_REASON_COPY[code].trim().length).toBeGreaterThan(0);
    }
  });

  it("phrases every sentence as evidence rather than surveillance", () => {
    // The issue names the banned form explicitly: 「我们检测到你居住在深圳。」
    for (const copy of Object.values(HOME_BASE_EVIDENCE_REASON_COPY)) {
      expect(copy).not.toContain("我们检测到");
      expect(copy).not.toContain("居住");
      expect(copy).not.toContain("监测");
    }
  });
});

describe("which inference states may become a card", () => {
  it("shows nothing for insufficient evidence, an internal candidate or a dismissal", () => {
    for (const state of ["insufficient_evidence", "candidate", "dismissed"] as const) {
      const decision = resolveHomeBaseSuggestion({
        result: inferenceResult(state),
        placeLabel: "深圳",
      });
      expect(decision.visible).toBe(false);
      expect(decision.variant).toBe("none");
      expect(decision.headline).toBeNull();
      expect(decision.primaryAction).toBeNull();
    }
  });

  it("shows nothing while Journey Story or Journey Playback owns the screen", () => {
    const decision = resolveHomeBaseSuggestion({
      result: inferenceResult("suggested"),
      placeLabel: "深圳",
      narrativeSurfaceActive: true,
    });
    expect(decision.visible).toBe(false);
  });

  it("shows nothing when no Place Label can name the region truthfully", () => {
    expect(resolveHomeBaseSuggestion({
      result: inferenceResult("suggested"),
      placeLabel: null,
    }).visible).toBe(false);
  });
});

describe("the suggestion copy explains the evidence", () => {
  it("uses the issue's evidence phrasing for a first suggestion", () => {
    const decision = resolveHomeBaseSuggestion({
      result: inferenceResult("suggested"),
      placeLabel: "深圳",
    });
    expect(decision.visible).toBe(true);
    expect(decision.variant).toBe("initial");
    expect(decision.headline).toBe("看起来深圳是你这一阶段经常出发和回来的地方。");
    expect(decision.evidenceCopy).toBe("最近几段旅程经常从深圳附近开始或结束。");
    expect(decision.question).toBe("设为常住地？");
    expect(decision.primaryAction).toEqual({ kind: "confirm", label: "设为常住地" });
    expect(decision.secondaryAction).toEqual({ kind: "dismiss_soft", label: "暂时不用" });
    expect(decision.rejectAction).toEqual({ kind: "dismiss_rejected", label: "不是深圳" });
  });

  it("never produces the surveillance phrasing the issue forbids", () => {
    const decision = resolveHomeBaseSuggestion({
      result: inferenceResult("suggested"),
      placeLabel: "深圳",
    });
    const everyString = [
      decision.headline,
      decision.question,
      decision.evidenceCopy,
      ...decision.reasonCopy,
      decision.primaryAction?.label,
      decision.secondaryAction?.label,
      decision.rejectAction?.label,
    ].join(" ");
    expect(everyString).not.toContain("我们检测到你居住在");
    expect(everyString).not.toContain("我们检测到");
    expect(everyString).not.toContain("居住");
  });

  it("offers keeping the current Home Base as the move card's quiet answer", () => {
    const decision = resolveHomeBaseSuggestion({
      result: inferenceResult("move_suggested", { proposedPeriodStart: "2026-05-02" }),
      placeLabel: "东京",
      confirmedPlaceLabel: "深圳",
    });
    expect(decision.variant).toBe("move");
    expect(decision.headline).toBe("最近你的记录更多从东京附近开始和结束。");
    expect(decision.question).toBe("要把东京作为新的常住地吗？");
    expect(decision.primaryAction).toEqual({ kind: "confirm_move", label: "设为新的常住地" });
    expect(decision.secondaryAction).toEqual({ kind: "dismiss_soft", label: "保持深圳" });
    // A move is a correction of the current Home Base, not a claim the member
    // can reject as wrong about a place they never confirmed.
    expect(decision.rejectAction).toBeNull();
    expect(decision.proposedPeriodStart).toBe("2026-05-02");
  });
});

describe("the Place Label the card names", () => {
  const journey = (
    label: string | null,
    latitude = ANCHOR.latitude,
    longitude = ANCHOR.longitude,
    id = label ?? "journey",
  ) => ({
    id,
    routePoints: [
      { id: `${id}-start`, sortOrder: 0, latitude, longitude, label },
      { id: `${id}-end`, sortOrder: 1, latitude, longitude, label },
    ],
  });

  it("takes the most frequent Place Label the member wrote inside the region", () => {
    expect(resolveHomeBasePlaceLabel(
      [journey("深圳"), journey("深圳"), journey("广州湾")],
      ANCHOR,
    )).toBe("深圳");
  });

  it("counts one Journey once however many endpoints carry the same label", () => {
    // Both endpoints of the single Tokyo Journey say 东京, so it must not
    // outvote the two separate Shenzhen Journeys.
    expect(resolveHomeBasePlaceLabel(
      [journey("东京"), journey("深圳"), journey("深圳")],
      ANCHOR,
    )).toBe("深圳");
  });

  it("ignores Place Labels outside the Home Base clustering radius", () => {
    expect(resolveHomeBasePlaceLabel(
      [journey("北京", 39.9042, 116.4074), journey("北京", 39.9042, 116.4074), journey("深圳")],
      ANCHOR,
    )).toBe("深圳");
  });

  it("returns nothing rather than inventing a name", () => {
    expect(resolveHomeBasePlaceLabel([journey(null), journey("   ")], ANCHOR)).toBeNull();
    expect(resolveHomeBasePlaceLabel([journey("深圳")], null)).toBeNull();
  });

  it("lets only Journeys named by the inference evidence vote on the label", () => {
    const journeys = [
      journey("深圳", ANCHOR.latitude, ANCHOR.longitude, "support-1"),
      journey("深圳", ANCHOR.latitude, ANCHOR.longitude, "support-2"),
      journey("东京", ANCHOR.latitude, ANCHOR.longitude, "future-1"),
      journey("东京", ANCHOR.latitude, ANCHOR.longitude, "future-2"),
      journey("东京", ANCHOR.latitude, ANCHOR.longitude, "future-3"),
    ];
    const digest = "hbi-v2:22.5431:114.0579:2:2026-01-04:2026-08-18:support-1=11,support-2=11:deadbeef";
    expect(resolveHomeBasePlaceLabel(journeys, ANCHOR)).toBe("东京");
    expect(resolveHomeBasePlaceLabel(journeys, ANCHOR, digest)).toBe("深圳");
  });

  it("lets only endpoint kinds carried by the inference evidence vote", () => {
    const unfinished = {
      id: "unfinished",
      routePoints: [
        { id: "unfinished-start", sortOrder: 0, latitude: ANCHOR.latitude, longitude: ANCHOR.longitude, label: "深圳" },
        { id: "unfinished-draft-end", sortOrder: 1, latitude: ANCHOR.latitude, longitude: ANCHOR.longitude, label: "东京" },
      ],
    };
    const digest = "hbi-v2:22.5431:114.0579:1:2026-01-04:2026-01-04:unfinished=10:deadbeef";
    expect(resolveHomeBasePlaceLabel([unfinished], ANCHOR, digest)).toBe("深圳");
  });

  it("uses the core's sort-order endpoint semantics before applying evidence flags", () => {
    const reversed = {
      id: "ordered",
      routePoints: [
        { id: "ordered-end", sortOrder: 1, latitude: ANCHOR.latitude, longitude: ANCHOR.longitude, label: "东京" },
        { id: "ordered-start", sortOrder: 0, latitude: ANCHOR.latitude, longitude: ANCHOR.longitude, label: "深圳" },
      ],
    };
    const digest = "hbi-v2:22.5431:114.0579:1:2026-01-04:2026-01-04:ordered=10:deadbeef";
    expect(resolveHomeBasePlaceLabel([reversed], ANCHOR, digest)).toBe("深圳");
  });

  it("fails closed when evidence identity cannot be read", () => {
    expect(resolveHomeBasePlaceLabel([journey("深圳")], ANCHOR, "malformed")).toBeNull();
  });
});

describe("the period a confirmation writes", () => {
  it("starts a first Home Base at the earliest supporting evidence", () => {
    const result = inferenceResult("suggested");
    const decision = resolveHomeBaseSuggestion({ result, placeLabel: "深圳" });
    expect(homeBaseConfirmationDraft(decision, result)).toEqual({
      label: "深圳",
      latitude: ANCHOR.latitude,
      longitude: ANCHOR.longitude,
      startedOn: "2026-01-04",
      endedOn: null,
      source: "suggested-confirmed",
    });
  });

  it("starts a move at the inferred onset so #231 closes the previous period there", () => {
    const result = inferenceResult("move_suggested", { proposedPeriodStart: "2026-05-02" });
    const decision = resolveHomeBaseSuggestion({
      result,
      placeLabel: "东京",
      confirmedPlaceLabel: "深圳",
    });
    const draft = homeBaseConfirmationDraft(decision, result);
    // `endedOn: null` plus a start after the open period is exactly the write
    // `classifyHomeBasePeriodWrite` reads as a move: it closes the previous
    // period ON that day rather than rewriting it.
    expect(draft).toMatchObject({ startedOn: "2026-05-02", endedOn: null, label: "东京" });
  });

  it("writes nothing for a card that is not shown", () => {
    const result = inferenceResult("candidate");
    const decision = resolveHomeBaseSuggestion({ result, placeLabel: "深圳" });
    expect(homeBaseConfirmationDraft(decision, result)).toBeNull();
  });

  it("writes nothing for a move with no inferred onset", () => {
    const result = inferenceResult("move_suggested", { proposedPeriodStart: null });
    const decision = resolveHomeBaseSuggestion({
      result,
      placeLabel: "东京",
      confirmedPlaceLabel: "深圳",
    });
    expect(homeBaseConfirmationDraft(decision, result)).toBeNull();
  });
});
