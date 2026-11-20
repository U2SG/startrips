import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MEDIA_PLACEMENT_PROPOSAL_ALGORITHM_VERSION,
  planMediaPlacementProposals,
  type MediaPlacementProposalBasis,
  type MediaPlacementSignal,
} from "./mediaPlacement";
import type { Journey } from "./types";

// The iOS planner (mobile/ios/NativeMedia/Sources/RouteBatch) consumes the
// same file in its unit tests, so the two ports cannot drift apart silently.
type FixtureCase = {
  name: string;
  journey: {
    id: string;
    revision: number;
    startedOn: string;
    endedOn: string | null;
    routePoints: Array<{ id: string; latitude: number; longitude: number; occurredAt: string | null }>;
  };
  inputs: Array<{ id: string; signal: MediaPlacementSignal | null }>;
  expected: {
    matchExisting: Array<{ routePointId: string; files: string[]; basis: MediaPlacementProposalBasis }>;
    suggestNew: Array<{
      files: string[];
      representative: { file: string; latitude: number; longitude: number };
      basis: MediaPlacementProposalBasis;
    }>;
    pendingConfirmation: Array<{ files: string[]; basis: MediaPlacementProposalBasis }>;
  };
};

const fixture = JSON.parse(readFileSync(
  new URL("../../mobile/ios/NativeMedia/Tests/Fixtures/route-point-proposals.json", import.meta.url),
  "utf8",
)) as { algorithmVersion: string; cases: FixtureCase[] };

function journeyOf(value: FixtureCase["journey"]): Journey {
  return {
    id: value.id, atlasId: "atlas-parity", title: value.id, startedOn: value.startedOn, endedOn: value.endedOn,
    note: "", lightColor: "#f4ce73", revision: value.revision, createdByUserId: "user-parity",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", media: [],
    routePoints: value.routePoints.map((point, sortOrder) => ({
      ...point, journeyId: value.id, sortOrder, label: point.id, isStop: true, createdAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

describe("route point proposal parity fixture", () => {
  it("names the planner version both ports implement", () => {
    expect(fixture.algorithmVersion).toBe(MEDIA_PLACEMENT_PROPOSAL_ALGORITHM_VERSION);
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases.map((value) => [value.name, value] as const))("%s", (_name, value) => {
    const ids = value.inputs.map((input) => input.id);
    const files = (indexes: readonly number[]) => indexes.map((index) => ids[index]);
    const plan = planMediaPlacementProposals(
      value.inputs.map((input, fileIndex) => ({ fileIndex, signal: input.signal })),
      journeyOf(value.journey),
      { batchId: "parity" },
    );
    expect({
      matchExisting: plan.matchExisting.map((proposal) => ({
        routePointId: proposal.routePointId, files: files(proposal.fileIndexes), basis: proposal.basis,
      })),
      suggestNew: plan.suggestNew.map((proposal) => ({
        files: files(proposal.fileIndexes),
        representative: {
          file: ids[proposal.representative.fileIndex],
          latitude: proposal.representative.latitude,
          longitude: proposal.representative.longitude,
        },
        basis: proposal.basis,
      })),
      pendingConfirmation: plan.pendingConfirmation.map((proposal) => ({
        files: files(proposal.fileIndexes), basis: proposal.basis,
      })),
    }).toEqual(value.expected);
  });
});
