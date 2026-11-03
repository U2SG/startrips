import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Journey } from "./types";
import type { MediaPlacementProposalPlan } from "./mediaPlacement";
import { createRoutePointBatchDraft, editRoutePointBatchDraft } from "./routePointBatchDraft";
import { RoutePointBatchReview } from "./RoutePointBatchReview";

const journey: Journey = {
  id: "journey", atlasId: "atlas", title: "Journey",
  startedOn: "2026-09-01", endedOn: null, note: "", lightColor: "#fff",
  revision: 1, createdByUserId: "owner", createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z", media: [],
  routePoints: [{
    id: "point-1", journeyId: "journey", sortOrder: 0, latitude: 22.54,
    longitude: 114.06, label: "福田", isStop: true,
    occurredAt: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  }],
};

const proposal: MediaPlacementProposalPlan = {
  algorithmVersion: "route-point-proposal-v1",
  scope: { batchId: "batch", journeyId: "journey", routeRevision: 1 },
  matchExisting: [{
    kind: "match-existing", journeyId: "journey", routePointId: "point-1", fileIndexes: [0],
    basis: { reason: "existing-route-point-evidence", evidence: ["exif"], uncertainty: [] },
  }],
  suggestNew: [{
    kind: "suggest-new", candidateId: "new:1", fileIndexes: [1],
    representative: { fileIndex: 1, latitude: 25.03, longitude: 121.56 },
    basis: { reason: "single-observation-candidate", evidence: ["exif"], uncertainty: ["single-observation-candidate"] },
  }],
  pendingConfirmation: [{
    kind: "pending-confirmation", fileIndexes: [2],
    basis: { reason: "missing-coordinate-evidence", evidence: [], uncertainty: ["unknown-location"] },
  }],
};

describe("RoutePointBatchReview accessible markup / #337", () => {
  it("shows grouped drafts with explicit provenance, no-GPS bucket, edit controls and off opt-in", () => {
    const draft = createRoutePointBatchDraft(proposal, journey, [
      { status: "signal", signal: {
        latitude: 22.54, longitude: 114.06, spatialSource: "exif",
        spatialGranularity: "coordinate", accuracyMeters: 12,
        capturedAt: "2026-09-01T10:00:00+08:00", timezoneState: "offset-known",
      } },
      { status: "signal", signal: {
        latitude: 25.03, longitude: 121.56, spatialSource: "exif",
        spatialGranularity: "coordinate", accuracyMeters: 45,
        capturedLocal: "2026-09-02T10:00:00", timezoneState: "local-only",
      } },
      { status: "no-evidence" },
    ], 3);
    const markup = renderToStaticMarkup(createElement(RoutePointBatchReview, {
      draft, journey, onEdit: () => {}, onCancel: () => {}, onConfirm: () => {},
    }));
    expect(markup).toContain('aria-label="批量媒体途径点草案审阅"');
    expect(markup).toContain("草案尚未创建途径点");
    expect(markup).toContain("已有途径点");
    expect(markup).toContain("新途径点 · 草案");
    expect(markup).toContain("未归属媒体");
    expect(markup).toContain("位置待确认");
    expect(markup).toContain("精度未知");
    expect(markup).toContain("上移第 2 组");
    expect(markup).toContain("下移第 1 组");
    expect(markup).toContain("拆出最后一个媒体");
    expect(markup).toContain("合并目标");
    expect(markup).toContain("仅本批允许自动整理");
    expect(markup).not.toContain('type="checkbox" checked=""');
    expect(markup).toContain("默认不自动整理");
    const opted = editRoutePointBatchDraft(draft, { type: "auto-organize", enabled: true }, journey);
    const optedMarkup = renderToStaticMarkup(createElement(RoutePointBatchReview, {
      draft: opted, journey, onEdit: () => {}, onCancel: () => {}, onConfirm: () => {},
    }));
    expect(optedMarkup).toContain("仍需逐组审阅");
  });
});
