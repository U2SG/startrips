import { describe, expect, it } from "vitest";
import { matchesCameraHandback } from "./qa-camera-handback.mjs";

describe("camera handback evidence", () => {
  it("accepts matching finite coordinates, including zero", () => {
    expect(matchesCameraHandback([0, 0], { cameraHandbackLat: 0, cameraHandbackLon: 0 })).toBe(true);
    expect(matchesCameraHandback([12, 34], { cameraHandbackLat: 34.00001, cameraHandbackLon: 12 })).toBe(true);
  });
  it("rejects stale or swapped observations at the existing tolerance", () => {
    expect(matchesCameraHandback([12, 34], { cameraHandbackLat: 34.001, cameraHandbackLon: 12 })).toBe(false);
    expect(matchesCameraHandback([12, 34], { cameraHandbackLat: 12, cameraHandbackLon: 34 })).toBe(false);
  });
  it.each([undefined, null, NaN, Infinity, -Infinity, "34"])("rejects missing or non-finite handback coordinates: %s", value => {
    expect(matchesCameraHandback([12, 34], { cameraHandbackLat: value, cameraHandbackLon: 12 })).toBe(false);
    expect(matchesCameraHandback([12, 34], { cameraHandbackLat: 34, cameraHandbackLon: value })).toBe(false);
  });
  it.each([undefined, null, [], [12], [12, NaN], [Infinity, 34], [12, 34, 56]])("rejects incomplete observation %j", observed => {
    expect(matchesCameraHandback(observed, { cameraHandbackLat: 34, cameraHandbackLon: 12 })).toBe(false);
  });
});
