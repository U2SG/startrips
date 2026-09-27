import { afterAll, describe, expect, it, vi } from "vitest";

const maplibre = vi.hoisted(() => ({
  addProtocol: vi.fn(),
}));

vi.mock("maplibre-gl", () => ({
  addProtocol: maplibre.addProtocol,
}));

vi.mock("pmtiles", () => ({
  Protocol: class {
    tile = vi.fn();
  },
}));

import { ensurePmtilesProtocol } from "./pmtilesProtocol";

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("optional PMTiles protocol registration", () => {
  it("registers exactly once and only after a PMTiles URL is configured", () => {
    vi.stubEnv("VITE_ATLAS_PMTILES_URL", "");
    expect(ensurePmtilesProtocol()).toBe(false);
    expect(maplibre.addProtocol).not.toHaveBeenCalled();

    vi.stubEnv("VITE_ATLAS_PMTILES_URL", "/basemap/gdhkm-2026-09.pmtiles");
    expect(ensurePmtilesProtocol()).toBe(true);
    expect(maplibre.addProtocol).toHaveBeenCalledTimes(1);
    expect(maplibre.addProtocol).toHaveBeenCalledWith("pmtiles", expect.any(Function));

    expect(ensurePmtilesProtocol()).toBe(false);
    expect(maplibre.addProtocol).toHaveBeenCalledTimes(1);
  });
});
