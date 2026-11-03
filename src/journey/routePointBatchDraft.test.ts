import { describe, expect, it } from "vitest";
import type { Journey } from "./types";
import type { MediaPlacementProposalPlan, MediaPlacementReadResult } from "./mediaPlacement";
import {
  buildRoutePointBatchApplyBody,
  canAutoOrganizeRoutePointBatch,
  createRoutePointBatchDraft,
  editRoutePointBatchDraft,
  reconcileRoutePointBatchDraft,
  resolveRoutePointBatchAssetAssignments,
  shouldAutoSubmitRoutePointBatch,
} from "./routePointBatchDraft";

const journey: Journey = {
  id: "journey", atlasId: "atlas", title: "Journey", startedOn: "2026-09-01",
  endedOn: null, note: "", lightColor: "#fff", revision: 7,
  createdByUserId: "owner", createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z", media: [],
  routePoints: [{
    id: "point", journeyId: "journey", sortOrder: 0, latitude: 22.54,
    longitude: 114.06, label: "深圳", isStop: true,
    occurredAt: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  }],
};

function plan(): MediaPlacementProposalPlan {
  return {
    algorithmVersion: "route-point-proposal-v1",
    scope: { batchId: "batch-one", journeyId: journey.id, routeRevision: journey.revision },
    matchExisting: [{
      kind: "match-existing", journeyId: journey.id, routePointId: "point",
      fileIndexes: [0], basis: { reason: "existing-route-point-evidence", evidence: ["gps"], uncertainty: [] },
    }],
    suggestNew: [{
      kind: "suggest-new", candidateId: "new:1-2", fileIndexes: [1, 2],
      representative: { fileIndex: 1, latitude: 25.03, longitude: 121.56 },
      basis: { reason: "spatiotemporal-cluster", evidence: ["gps", "time"], uncertainty: [] },
    }],
    pendingConfirmation: [{
      kind: "pending-confirmation", fileIndexes: [3],
      basis: { reason: "missing-coordinate-evidence", evidence: [], uncertainty: ["unknown-location"] },
    }],
  };
}

const reads: MediaPlacementReadResult[] = [
  { status: "signal", signal: {
    latitude: 22.54, longitude: 114.06, spatialSource: "exif",
    spatialGranularity: "coordinate", accuracyMeters: 10,
    capturedAt: "2026-09-01T10:00:00+08:00", timezoneState: "offset-known",
  } },
  { status: "signal", signal: {
    latitude: 25.03, longitude: 121.56, spatialSource: "exif",
    spatialGranularity: "coordinate", accuracyMeters: 18,
    capturedLocal: "2026-09-02T12:00:00", timezoneState: "local-only",
  } },
  { status: "signal", signal: {
    latitude: 25.04, longitude: 121.57, spatialSource: "exif",
    spatialGranularity: "coordinate", accuracyMeters: 22,
    capturedAt: "2026-09-02T04:30:00Z", timezoneState: "offset-known",
  } },
  { status: "no-evidence" },
];

const draft = () => createRoutePointBatchDraft(plan(), journey, reads, 4);

describe("Route Point batch review draft / #337", () => {
  it("renders every input exactly once with separate new/existing/unplaced, without borrowed GPS", () => {
    const value = draft();
    expect(value.groups.map(({ destination, fileIndexes }) => ({ destination, fileIndexes }))).toEqual([
      { destination: "existing", fileIndexes: [0] },
      { destination: "new", fileIndexes: [1, 2] },
      { destination: "unplaced", fileIndexes: [3] },
    ]);
    expect(value.groups[1].occurredAt).toBeNull(); // local wall clock has no UTC offset
    expect(value.groups[2]).toMatchObject({
      latitude: null, longitude: null, routePointId: null, spatialSource: "unknown",
    });
    expect(value.autoOrganize).toBe(false);
  });

  it("rejects missing or duplicated media, foreign targets and stale revision", () => {
    expect(() => createRoutePointBatchDraft({
      ...plan(), pendingConfirmation: [],
    }, journey, reads, 4)).toThrow(/omitted/);
    expect(() => createRoutePointBatchDraft({
      ...plan(), pendingConfirmation: [{ ...plan().pendingConfirmation[0], fileIndexes: [2, 3] }],
    }, journey, reads, 4)).toThrow(/duplicated/);
    expect(() => createRoutePointBatchDraft({
      ...plan(), scope: { ...plan().scope, routeRevision: 8 },
    }, journey, reads, 4)).toThrow(/stale/);
    expect(() => createRoutePointBatchDraft({
      ...plan(), matchExisting: [{ ...plan().matchExisting[0], routePointId: "foreign" }],
    }, journey, reads, 4)).toThrow(/Unknown/);
  });

  it("edits only its target group and supports an explicit spatial/temporal correction", () => {
    const original = draft();
    const id = original.groups[1].id;
    const named = editRoutePointBatchDraft(original, { type: "rename", id, value: "台北" }, journey);
    expect(named.groups[1].label).toBe("台北");
    expect(named.groups[0]).toEqual(original.groups[0]);
    expect(original.groups[1].label).toBe("新途径点草案");
    const relocated = editRoutePointBatchDraft(named, {
      type: "reposition", id, latitude: 25.04, longitude: 121.6,
    }, journey);
    expect(relocated.groups[1]).toMatchObject({ accuracyMeters: null, spatialSource: "manual" });
    const retimed = editRoutePointBatchDraft(relocated, {
      type: "retime", id, value: "2026-09-02T12:00:00+08:00",
    }, journey);
    expect(retimed.groups[1].occurredAt).toBe("2026-09-02T04:00:00.000Z");
    expect(() => editRoutePointBatchDraft(original, {
      type: "retime", id, value: "2026-09-02T12:00:00",
    }, journey)).toThrow(/offset/);
  });

  it("splits and merges with no silently inherited location or media loss", () => {
    const value = draft();
    const id = value.groups[1].id;
    const split = editRoutePointBatchDraft(value, { type: "split", id, fileIndex: 2 }, journey);
    expect(split.groups[1].fileIndexes).toEqual([1]);
    expect(split.groups[2].fileIndexes).toEqual([2]);
    expect(split.groups[1].latitude).toBeNull();
    expect(split.groups[2].latitude).toBeNull();
    const merged = editRoutePointBatchDraft(split, {
      type: "merge", id, otherId: split.groups[2].id,
    }, journey);
    expect(merged.groups[1].fileIndexes).toEqual([1, 2]);
    expect(merged.groups[1].accuracyMeters).toBeNull();
    expect(merged.groups[1].manual).toBe(true);
    expect(merged.groups.flatMap(({ fileIndexes }) => fileIndexes).sort()).toEqual([0, 1, 2, 3]);
  });

  it("allows explicit up/down and assignment to Journey-level or an existing point", () => {
    const value = draft();
    const pendingId = value.groups[2].id;
    const moved = editRoutePointBatchDraft(value, { type: "move", id: pendingId, direction: -1 }, journey);
    expect(moved.groups[1].id).toBe(pendingId);
    const assigned = editRoutePointBatchDraft(value, {
      type: "assign", id: pendingId, routePointId: "point",
    }, journey);
    expect(assigned.groups[2].routePointId).toBe("point");
    expect(assigned.groups[2].accuracyMeters).toBeNull();
    const unplaced = editRoutePointBatchDraft(assigned, {
      type: "assign", id: pendingId, routePointId: null,
    }, journey);
    expect(unplaced.groups[2].destination).toBe("unplaced");
    expect(() => editRoutePointBatchDraft(value, {
      type: "assign", id: pendingId, routePointId: "foreign",
    }, journey)).toThrow(/Unknown/);
  });

  it("never carries opt-in to a fresh batch, or auto-submits pending/manual/uncertain evidence", () => {
    const original = draft();
    expect(canAutoOrganizeRoutePointBatch(original)).toBe(false);
    const enabled = editRoutePointBatchDraft(original, { type: "auto-organize", enabled: true }, journey);
    expect(canAutoOrganizeRoutePointBatch(enabled)).toBe(false); // GPS-less media remains pending
    expect(draft().autoOrganize).toBe(false);
    const eligiblePlan = { ...plan(), pendingConfirmation: [] };
    const eligible = createRoutePointBatchDraft(eligiblePlan, journey, reads, 3);
    expect(canAutoOrganizeRoutePointBatch(eligible)).toBe(false);
    const optedIn = editRoutePointBatchDraft(eligible, { type: "auto-organize", enabled: true }, journey);
    expect(canAutoOrganizeRoutePointBatch(optedIn)).toBe(true);
    const edited = editRoutePointBatchDraft(optedIn, {
      type: "rename", id: optedIn.groups[1].id, value: "人工命名",
    }, journey);
    expect(canAutoOrganizeRoutePointBatch(edited)).toBe(false);
  });

  it("executes per-batch authorized auto opt-in immediately, never manual or uncertain proposals", () => {
    const pending = editRoutePointBatchDraft(draft(), { type: "auto-organize", enabled: true }, journey);
    expect(shouldAutoSubmitRoutePointBatch(pending, { type: "auto-organize", enabled: true })).toBe(false);
    const eligible = createRoutePointBatchDraft({ ...plan(), pendingConfirmation: [] }, journey, reads, 3);
    const opted = editRoutePointBatchDraft(eligible, { type: "auto-organize", enabled: true }, journey);
    expect(shouldAutoSubmitRoutePointBatch(opted, { type: "auto-organize", enabled: true })).toBe(true);
    expect(shouldAutoSubmitRoutePointBatch(opted, { type: "auto-organize", enabled: false })).toBe(false);
    expect(shouldAutoSubmitRoutePointBatch(opted, { type: "rename", id: opted.groups[0].id, value: "edit" })).toBe(false);
    const manuallyEdited = editRoutePointBatchDraft(opted, {
      type: "rename", id: opted.groups[1].id, value: "人工编辑",
    }, journey);
    expect(shouldAutoSubmitRoutePointBatch(manuallyEdited, { type: "auto-organize", enabled: true })).toBe(false);
    expect(draft().autoOrganize).toBe(false); // no future batch preference
  });

  it("preserves manual edits across a planner refresh, without accepting new batch or revision", () => {
    const initial = draft();
    const id = initial.groups[1].id;
    const edited = editRoutePointBatchDraft(initial, { type: "rename", id, value: "我选的台北" }, journey);
    const rerunPlan = { ...plan(), suggestNew: [{ ...plan().suggestNew[0], candidateId: "new:rerun" }] };
    const refreshed = createRoutePointBatchDraft(rerunPlan, journey, reads, 4);
    const reconciled = reconcileRoutePointBatchDraft(edited, refreshed);
    expect(reconciled.groups.find((group) => group.id === id)?.label).toBe("我选的台北");
    expect(reconciled.groups.flatMap((group) => group.fileIndexes).sort()).toEqual([0, 1, 2, 3]);
    expect(() => reconcileRoutePointBatchDraft(edited, {
      ...refreshed, scope: { ...refreshed.scope, routeRevision: 8 },
    })).toThrow(/revision/);
  });

  it("builds an idempotent #336 batch request excluding unplaced media and preventing partial assets", () => {
    const value = editRoutePointBatchDraft(draft(), {
      type: "rename", id: "new:1-2", value: "台北",
    }, journey);
    const request = buildRoutePointBatchApplyBody(value, ["a", "b", "c", "d"], "batch-one");
    expect(request).toMatchObject({
      operationId: "batch-one", baseRevision: 7,
      points: [{ candidateId: "new:1-2", label: "台北", isStop: true, occurredAt: null }],
    });
    expect(request?.attachments).toEqual([
      { assetId: "a", routePointId: "point", intentionalReuse: false },
      { assetId: "b", candidateId: "new:1-2", intentionalReuse: false },
      { assetId: "c", candidateId: "new:1-2", intentionalReuse: false },
    ]);
    expect(() => buildRoutePointBatchApplyBody(value, ["a", "", "c", "d"], "batch-one")).toThrow(/incomplete/);
  });

  it("builds one idempotent receipt-backed move-only request, leaving unplaced assets alone", () => {
    const moveOnly = createRoutePointBatchDraft({
      ...plan(), suggestNew: [],
      pendingConfirmation: [{ ...plan().pendingConfirmation[0], fileIndexes: [1, 2, 3] }],
    }, journey, reads, 4);
    const request = buildRoutePointBatchApplyBody(moveOnly, ["a", "b", "c", "d"], "move-only");
    expect(request).toEqual({
      operationId: "move-only", baseRevision: 7, points: [],
      attachments: [{ assetId: "a", routePointId: "point", intentionalReuse: false }],
    });
    const allUnplaced = createRoutePointBatchDraft({
      ...plan(), matchExisting: [], suggestNew: [],
      pendingConfirmation: [{ ...plan().pendingConfirmation[0], fileIndexes: [0, 1, 2, 3] }],
    }, journey, reads, 4);
    expect(buildRoutePointBatchApplyBody(allUnplaced, ["a", "b", "c", "d"], "no-op")).toBeNull();
  });

  it("collapses deduplicated multipart assets only when their destinations agree", () => {
    const value = draft();
    const assignments = resolveRoutePointBatchAssetAssignments(value, ["a", "duplicate", "duplicate", "d"]);
    expect(assignments).toHaveLength(3);
    const request = buildRoutePointBatchApplyBody(value, ["a", "duplicate", "duplicate", "d"], "batch-one");
    expect(request?.attachments).toEqual([
      { assetId: "a", routePointId: "point", intentionalReuse: false },
      { assetId: "duplicate", candidateId: "new:1-2", intentionalReuse: false },
    ]);
    // One physical asset must not silently be assigned both to an existing
    // point and a new candidate. The UI retains uploaded ids for reconciliation.
    expect(() => buildRoutePointBatchApplyBody(
      value, ["duplicate", "duplicate", "c", "d"], "batch-one",
    )).toThrow(/同一上传媒体被分配到不同地点/);
  });

  it("clears explicit capture time on both split subsets, not just the removed file", () => {
    const value = draft();
    const retimed = editRoutePointBatchDraft(value, {
      type: "retime", id: "new:1-2", value: "2026-09-02T12:00:00+08:00",
    }, journey);
    expect(retimed.groups[1].occurredAt).toBe("2026-09-02T04:00:00.000Z");
    const split = editRoutePointBatchDraft(retimed, {
      type: "split", id: "new:1-2", fileIndex: 1,
    }, journey);
    expect(split.groups[1].fileIndexes).toEqual([2]);
    expect(split.groups[2].fileIndexes).toEqual([1]);
    expect(split.groups[1].occurredAt).toBeNull();
    expect(split.groups[2].occurredAt).toBeNull();
  });
});
