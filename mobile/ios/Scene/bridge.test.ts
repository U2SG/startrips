import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../Fixtures/bridge.json";
import { buildJourneyTimeline, resolveJourneyTimelineSelection } from "../../../src/journey/globeTimeline";
import { toJourneyRoutes } from "../../../src/journey/journeyModel";
import { GLOBE_IDLE_RESUME_DELAY_MS, getGlobeIdleRotationDelta, resolveGlobeFocusIntent } from "../../../src/scene/ParticleEarthScene";
import { acceptsSnapshot, atlasSceneFocus, CONTRACT_VERSION, decodeCommand, decodeCommandOrDrop, decodeSnapshot, decodeSnapshotOrReport, renderJourneys, windowReveal } from "./bridge";

describe("the same redacted fixture as Swift", () => {
  it("decodes stable IDs and preserves server point order", () => {
    const snapshot = decodeSnapshot(fixture.snapshot);
    expect(renderJourneys(snapshot)[0].routePoints.map((point) => point.id)).toEqual(["point-a", "point-b"]);
    expect(snapshot.selection?.assetId).toBeNull();
    expect(snapshot.journeys[0].media[0].routePointId).toBe("point-a");
  });
  it("scrubs the same fixture between actual Route Points, and leaves idle rotation to the renderer", () => {
    const journeys = renderJourneys(decodeSnapshot(fixture.snapshot));
    const { entries } = buildJourneyTimeline(journeys);
    expect(resolveJourneyTimelineSelection(entries, 0)?.pointIndex).toBe(0);
    expect(resolveJourneyTimelineSelection(entries, 1)?.pointIndex).toBe(1);
    const route = toJourneyRoutes(journeys)[0];
    const point = journeys[0].routePoints[1];
    const focused = atlasSceneFocus(point, route);
    const overview = atlasSceneFocus(undefined, route);
    expect(resolveGlobeFocusIntent(focused.focusPoint, focused.focusRoute, 2)).toMatchObject({
      kind: "point", point: { lat: point.latitude, lon: point.longitude },
    });
    expect(resolveGlobeFocusIntent(overview.focusPoint, overview.focusRoute, 3)?.kind).toBe("route");
    expect(GLOBE_IDLE_RESUME_DELAY_MS).toBe(20_000);
    expect(getGlobeIdleRotationDelta(1 / 60, 19_999, false, false)).toBe(0);
    expect(getGlobeIdleRotationDelta(1 / 60, 20_001, false, false)).toBeGreaterThan(0);
    expect(getGlobeIdleRotationDelta(1 / 60, 20_001, true, false)).toBe(0);
  });
  it("drops late revisions and rebuilds a new process snapshot", () => {
    const snapshot = decodeSnapshot(fixture.snapshot);
    expect(acceptsSnapshot(snapshot, { ...snapshot, revision: snapshot.revision - 1 })).toBe(false);
    expect(acceptsSnapshot(null, snapshot)).toBe(true);
    expect(acceptsSnapshot(snapshot, { ...snapshot, scopeId: "guest-scope", revision: 0 })).toBe(true);
  });
  it("rejects invalid identity, revision, coordinates and cross-point media", () => {
    for (const mutate of [
      (value: typeof fixture.snapshot) => { value.version = 1; },
      (value: typeof fixture.snapshot) => { value.version = 3; },
      (value: typeof fixture.snapshot) => { value.revision = -1; },
      (value: typeof fixture.snapshot) => { value.journeys[0].routePoints[0].latitude = 91; },
      (value: typeof fixture.snapshot) => { value.selection.journeyId = "other"; },
      (value: typeof fixture.snapshot) => { value.journeys[0].media[0].routePointId = "other"; },
      (value: typeof fixture.snapshot) => { value.selection.revision = 100; },
    ]) {
      const value = structuredClone(fixture.snapshot); mutate(value);
      expect(() => decodeSnapshot(value)).toThrow();
    }
  });
});

describe("unreadable native snapshots", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts an unscoped sceneFailed event so native can offer its reload", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { webkit: { messageHandlers: { atlas: { postMessage } } } });
    expect(decodeSnapshotOrReport("{\"version\":1}")).toBeNull();
    expect(decodeSnapshotOrReport("not json")).toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(2);
    const message = JSON.parse(postMessage.mock.calls[0][0]);
    expect(message).toEqual({ version: CONTRACT_VERSION, kind: "sceneFailed", requestId: expect.any(String) });
    expect(message.requestId).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  });

  it("does not report a valid snapshot", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { webkit: { messageHandlers: { atlas: { postMessage } } } });
    expect(decodeSnapshotOrReport(JSON.stringify(fixture.snapshot))?.scopeId).toBe(fixture.snapshot.scopeId);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("native commands (contract v2)", () => {
  const snapshot = () => decodeSnapshot(structuredClone(fixture.snapshot));
  type Command = Record<string, unknown>;
  const clone = (index: number) => structuredClone(fixture.commands[index]) as Command;

  it("decodes every fixture command Swift also validates", () => {
    expect(fixture.commands.map((command) => decodeCommand(command, snapshot()).kind))
      .toEqual(["focus", "timeWindow", "chrome", "insets", "labels"]);
    expect(decodeCommand(fixture.commands[4], snapshot())).toMatchObject({ labels: { language: "bilingual", showPlaceNames: true } });
    expect(decodeCommand(fixture.commands[0], snapshot())).toMatchObject({ journeyId: "journey-fixture", routePointId: "point-b" });
    expect(decodeCommand({ ...clone(1), window: null }, snapshot())).toMatchObject({ kind: "timeWindow", window: null });
  });

  it("rejects stale scopes and revisions, and drops them silently", () => {
    expect(() => decodeCommand({ ...clone(2), revision: 6 }, snapshot())).toThrow("stale-command");
    expect(() => decodeCommand({ ...clone(2), scopeId: "guest-scope" }, snapshot())).toThrow("stale-command");
    expect(() => decodeCommand(clone(2), null)).toThrow("stale-command");
    expect(decodeCommandOrDrop(JSON.stringify({ ...clone(3), revision: 8 }), snapshot())).toBeNull();
    expect(decodeCommandOrDrop("not json", snapshot())).toBeNull();
  });

  it("rejects foreign targets, extra fields, bad windows and insets", () => {
    for (const command of [
      { ...clone(0), version: 1 },
      { ...clone(0), requestId: "not-a-uuid" },
      { ...clone(0), journeyId: "other" },
      { ...clone(0), routePointId: "point-valley" },
      { ...clone(0), globeOnly: true },
      { ...clone(1), journeyId: "journey-fixture" },
      { ...clone(1), window: { start: "2025-02-01", end: "2025-01-01" } },
      { ...clone(1), window: { start: "2025/01/01", end: "2025-01-02" } },
      { ...clone(2), globeOnly: "yes" },
      { ...clone(2), insets: { top: 1, bottom: 1 } },
      { ...clone(3), insets: { top: -1, bottom: 0 } },
      { ...clone(3), insets: { top: 0, bottom: Number.POSITIVE_INFINITY } },
      { ...clone(3), kind: "story" },
      { ...clone(4), labels: { language: "en", showPlaceNames: true } },
      { ...clone(4), labels: { language: "zh", showPlaceNames: "yes" } },
      { ...clone(4), labels: null },
      { ...clone(4), globeOnly: true },
      { ...clone(2), labels: { language: "zh", showPlaceNames: false } },
    ]) expect(() => decodeCommand(command, snapshot())).toThrow();
  });

  it("reveals only what the time window has reached", () => {
    const journeys = renderJourneys(snapshot());
    const before = windowReveal(journeys, { start: "2024-01-01", end: "2024-12-31" });
    expect(before.journeyProgress.get("journey-fixture")).toBe(0);
    expect(before.pointProgress.get("journey-fixture:0")).toBe(0);
    const first = windowReveal(journeys, { start: "2025-01-01", end: "2025-01-01" });
    expect(first.journeyProgress.get("journey-fixture")).toBeGreaterThan(0);
    expect(first.pointProgress.get("journey-fixture:0")).toBe(1);
    expect(first.pointProgress.get("journey-fixture:1")).toBe(0);
    const all = windowReveal(journeys, { start: "2025-01-01", end: "2025-12-31" });
    expect(all.journeyProgress.get("journey-fixture")).toBe(1);
    expect(all.pointProgress.get("journey-fixture:1")).toBe(1);
  });
});
