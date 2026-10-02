import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FragmentForm } from "./EverydayFragments";
import {
  createEverydayFragmentPlaceSearchCoordinator,
  everydayFragmentPlaceSearchErrorMessage,
  resolveEverydayFragmentPlaceSelection,
  runEverydayFragmentPlaceSearch,
} from "./EverydayFragmentPlaceInput";
import { JourneyApiError } from "./journeyApi";
import { journeyLocationSearchErrorMessage } from "./journeyLocationSearchError";
import type { EverydayFragment } from "./everydayFragment";
import type { LocationSearchResponse, LocationSearchResult } from "./types";

function result(overrides: Partial<LocationSearchResult> = {}): LocationSearchResult {
  return {
    id: "place-1",
    label: "Shenzhen Bay",
    labelLocal: "深圳湾",
    labelEnglish: "Shenzhen Bay",
    context: "Shenzhen, Guangdong",
    countryCode: "CN",
    latitude: 22.5001,
    longitude: 113.9442,
    ...overrides,
  };
}

function response(item: LocationSearchResult): LocationSearchResponse {
  return {
    results: [item],
    attribution: { label: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
  };
}

describe("Everyday Fragment place input", () => {
  it("renders search-first place selection inside FragmentForm while preserving manual fallback", () => {
    const markup = renderToStaticMarkup(createElement(FragmentForm, {
      save: async () => {
        throw new Error("not called during server render");
      },
      onSaved: () => {},
      onCancel: () => {},
    }));

    expect(markup).toContain("data-everyday-fragment-place-input");
    expect(markup).toContain("搜索地点");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain("找不到地点？手动输入坐标");
    expect(markup).toContain("纬度");
    expect(markup).toContain("经度");
    expect(markup).toContain("地点（选填）");
  });

  it("starts an edit from its exact persisted coordinates and place label", () => {
    const fragment: EverydayFragment = {
      id: "33333333-cccc-4333-8333-333333333333",
      occurredOn: "2026-09-30",
      latitude: 22.5431,
      longitude: 114.0579,
      placeLabel: "深圳",
      note: "晚风",
      homeBasePeriodId: null,
    };
    const markup = renderToStaticMarkup(createElement(FragmentForm, {
      fragment,
      save: async () => fragment,
      onSaved: () => {},
      onCancel: () => {},
    }));

    expect(markup).toContain('data-confirmed-place="true"');
    expect(markup).toContain("<strong>深圳</strong>");
    expect(markup).toContain('value="22.5431"');
    expect(markup).toContain('value="114.0579"');
    expect(markup).toContain('value="深圳"');
  });

  it("resolves an explicit result into one confirmed coordinate/label pair", () => {
    expect(resolveEverydayFragmentPlaceSelection(result())).toEqual({
      latitude: 22.5001,
      longitude: 113.9442,
      placeLabel: "深圳湾",
    });
    expect(resolveEverydayFragmentPlaceSelection(result({ labelLocal: undefined }))).toEqual({
      latitude: 22.5001,
      longitude: 113.9442,
      placeLabel: "Shenzhen Bay",
    });
  });

  it("ignores an older search response after a newer query wins", async () => {
    const coordinator = createEverydayFragmentPlaceSearchCoordinator();
    let resolveOld!: (value: LocationSearchResponse) => void;
    let resolveNew!: (value: LocationSearchResponse) => void;
    const oldPromise = new Promise<LocationSearchResponse>((resolve) => { resolveOld = resolve; });
    const newPromise = new Promise<LocationSearchResponse>((resolve) => { resolveNew = resolve; });

    const oldRun = runEverydayFragmentPlaceSearch("old", coordinator, async () => oldPromise);
    const newRun = runEverydayFragmentPlaceSearch("new", coordinator, async () => newPromise);
    resolveOld(response(result({ id: "old", label: "Old" })));
    await expect(oldRun).resolves.toBeNull();

    const newest = response(result({ id: "new", label: "New" }));
    resolveNew(newest);
    await expect(newRun).resolves.toEqual(newest);
  });

  it("invalidates in-flight results after a manual edit or unmount", async () => {
    const manualCoordinator = createEverydayFragmentPlaceSearchCoordinator();
    let resolveManual!: (value: LocationSearchResponse) => void;
    const manualPromise = new Promise<LocationSearchResponse>((resolve) => { resolveManual = resolve; });
    const manualRun = runEverydayFragmentPlaceSearch("shenzhen", manualCoordinator, async () => manualPromise);
    manualCoordinator.invalidate();
    resolveManual(response(result()));
    await expect(manualRun).resolves.toBeNull();

    const disposedCoordinator = createEverydayFragmentPlaceSearchCoordinator();
    let resolveDisposed!: (value: LocationSearchResponse) => void;
    const disposedPromise = new Promise<LocationSearchResponse>((resolve) => { resolveDisposed = resolve; });
    const disposedRun = runEverydayFragmentPlaceSearch("shenzhen", disposedCoordinator, async () => disposedPromise);
    disposedCoordinator.dispose();
    resolveDisposed(response(result()));
    await expect(disposedRun).resolves.toBeNull();
  });

  it("reactivates the coordinator after a StrictMode-style cleanup/setup replay", async () => {
    const coordinator = createEverydayFragmentPlaceSearchCoordinator();
    let resolveStale!: (value: LocationSearchResponse) => void;
    const stalePromise = new Promise<LocationSearchResponse>((resolve) => { resolveStale = resolve; });
    const staleRun = runEverydayFragmentPlaceSearch("stale", coordinator, async () => stalePromise);

    coordinator.dispose();
    coordinator.activate();
    resolveStale(response(result({ id: "stale" })));
    await expect(staleRun).resolves.toBeNull();

    const fresh = response(result({ id: "fresh", label: "Fresh" }));
    await expect(runEverydayFragmentPlaceSearch("fresh", coordinator, async () => fresh))
      .resolves.toEqual(fresh);
  });

  it("uses the shared location-search error vocabulary for provider and rate-limit failures", () => {
    const unavailable = new JourneyApiError(503, "LOCATION_SEARCH_UNAVAILABLE", "provider unavailable");
    const limited = new JourneyApiError(429, "LOCATION_SEARCH_RATE_LIMITED", "搜索太频繁，请稍后再试。");
    expect(everydayFragmentPlaceSearchErrorMessage(unavailable))
      .toBe(journeyLocationSearchErrorMessage(unavailable));
    expect(everydayFragmentPlaceSearchErrorMessage(limited))
      .toBe(journeyLocationSearchErrorMessage(limited));
    expect(everydayFragmentPlaceSearchErrorMessage(unavailable)).toContain("未启用地点搜索");
    expect(everydayFragmentPlaceSearchErrorMessage(limited)).toContain("搜索太频繁");
  });
});
