import { describe, expect, it } from "vitest";
import { DUR, attrs, frame, svg } from "./goatShowEngine";
import golden from "./goatShowGolden.fixture.json";

// The golden file is `attrs(frame(t))`, `trips`, `star` and `goat` written by
// the approved prototype engine (docs/plans/goat-proto/goat-show-engine.js).
const TOLERANCE = 1e-6;

function numbers(value: string) {
  return (value.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
}

function expectClose(actual: unknown, expected: unknown, path: string) {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    expect(Math.abs((actual as number) - expected), path).toBeLessThanOrEqual(TOLERANCE);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((item, index) => expectClose((actual as unknown[])[index], item, `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === "object") {
    // Compare only the keys the golden recorded (its `goat` keeps A, p and face).
    for (const [key, item] of Object.entries(expected)) {
      expectClose((actual as Record<string, unknown>)[key], item, `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

function finiteDeep(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteDeep);
  if (value && typeof value === "object") return Object.values(value).every(finiteDeep);
  return true;
}

describe("goat show engine", () => {
  it("lasts as long as the approved prototype", () => {
    expect(DUR).toBe(golden.durationMs);
  });

  it("matches every golden frame of the approved prototype", () => {
    expect(golden.frames.length).toBe(21);
    for (const expected of golden.frames) {
      const state = frame(expected.t);
      const actual = attrs(state);
      expect(Object.keys(actual).sort(), `attrs keys at ${expected.t}`).toEqual(Object.keys(expected.attrs).sort());
      for (const [part, value] of Object.entries(expected.attrs)) {
        expect(actual[part].replace(/-?\d*\.?\d+(?:e-?\d+)?/g, "#"), `${part} at ${expected.t}`)
          .toBe(value.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, "#"));
        expectClose(numbers(actual[part]), numbers(value), `attrs.${part} at ${expected.t}`);
      }
      expectClose(state.trips, expected.trips, `trips at ${expected.t}`);
      expectClose(state.star, expected.star, `star at ${expected.t}`);
      expectClose(state.goat, expected.goat, `goat at ${expected.t}`);
    }
  });

  it("ends exactly in the rest lockup", () => {
    const rest = frame(DUR);
    // The root transform is the identity: translate(A) rotate(0) scale(1 1) translate(-A).
    expect(rest.goat.A[0]).toBeCloseTo(719.7, 6);
    expect(rest.goat.A[1]).toBeCloseTo(0, 6);
    expect(rest.goat.p).toBeCloseTo(0, 6);
    expect(rest.goat.face).toBe(1);
    expect(rest.goat.neck).toBeCloseTo(0, 6);
    expect(rest.goat.head).toBeCloseTo(0, 6);
    expect(rest.goat.ears).toBeCloseTo(0, 6);
    expect(rest.goat.tail).toBeCloseTo(0, 6);
    // The star is back on the i as its dot, at full size and a whole number of turns.
    expect(rest.star.p[0]).toBeCloseTo(417.408, 6);
    expect(rest.star.p[1]).toBeCloseTo(-105.264, 6);
    expect(rest.star.s).toBeCloseTo(1, 6);
    expect(rest.star.r % 360).toBeCloseTo(0, 6);
    // Every leg joint is back at its drawn angle (only the IK reach clamp keeps it off exact zero).
    for (const segments of Object.values(rest.legs)) {
      for (const rotation of segments) expect(Math.abs(rotation)).toBeLessThan(1e-3);
    }
    // "trips" lies flat on the baseline with the p descender showing.
    expect(rest.trips.th).toBe(0);
    expect(rest.trips.sink).toBe(0);
    expect(rest.trips.notch).toBe(50);
  });

  it("never produces NaN or Infinity from 0 to DUR in 10 ms steps", () => {
    for (let t = 0; t <= DUR; t += 10) {
      const state = frame(t);
      expect(finiteDeep(state), `state at ${t}`).toBe(true);
      expect(Object.values(attrs(state)).some((value) => /NaN|Infinity/.test(value)), `attrs at ${t}`).toBe(false);
    }
  });

  it("builds markup with one clip id and every animated part", () => {
    const markup = svg("startrips-goat-show__svg", frame(0), "-20 -300 820 360", "", "goat-show-test");
    expect(markup).toContain('viewBox="-20 -300 820 360"');
    expect(markup).toContain('<clipPath id="goat-show-test"');
    expect(markup).toContain('clip-path="url(#goat-show-test)"');
    for (const part of [...Object.keys(attrs(frame(0))), "notch"]) {
      expect(markup).toContain(`data-part="${part}"`);
    }
  });
});
