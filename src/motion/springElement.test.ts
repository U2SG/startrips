import { describe, expect, it } from "vitest";
import { springTransformVelocity, stepSpring, type SpringValue } from "./springElement";

describe("stepSpring", () => {
  it.each([20, 2 * Math.sqrt(320), 60])("settles at the target with damping %s", (damping) => {
    let value: SpringValue = { position: -120, velocity: 450 };
    for (let frame = 0; frame < 240; frame += 1) value = stepSpring(value, 80, 1 / 60, 320, damping);
    expect(value.position).toBeCloseTo(80, 5);
    expect(value.velocity).toBeCloseTo(0, 5);
  });

  it("keeps momentum when the target reverses, then returns", () => {
    const outward = stepSpring({ position: 0, velocity: 0 }, 100, 0.08);
    expect(outward.velocity).toBeGreaterThan(0);
    const interrupted = stepSpring(outward, -100, 0.001);
    expect(interrupted.position).toBeGreaterThan(outward.position);
    expect(interrupted.velocity).toBeGreaterThan(0);
    const returned = stepSpring(interrupted, -100, 3);
    expect(returned.position).toBeCloseTo(-100, 5);
    expect(returned.velocity).toBeCloseTo(0, 5);
  });

  it.each([20, 2 * Math.sqrt(320), 60])("is stable across a suspended frame with damping %s", (damping) => {
    const initial = { position: 600, velocity: -800 };
    const longFrame = stepSpring(initial, -50, 0.75, 320, damping);
    let shortFrames = initial;
    for (let frame = 0; frame < 45; frame += 1) shortFrames = stepSpring(shortFrames, -50, 1 / 60, 320, damping);
    expect(longFrame.position).toBeCloseTo(shortFrames.position, 8);
    expect(longFrame.velocity).toBeCloseTo(shortFrames.velocity, 8);
    const resumed = stepSpring(initial, -50, 60, 320, damping);
    expect(resumed.position).toBe(-50);
    expect(Math.abs(resumed.velocity)).toBeLessThan(1e-8);
  });

  it("does not advance when timestamps repeat or move backwards", () => {
    const value = { position: 7, velocity: 30 };
    expect(stepSpring(value, 50, 0)).toEqual(value);
    expect(stepSpring(value, 50, -0.01)).toEqual(value);
  });
});

describe("springTransformVelocity", () => {
  it("converts painted matrix differences into per-second release velocity", () => {
    const before = new Float64Array(16);
    const after = new Float64Array(16);
    before[0] = after[0] = 1;
    before[5] = after[5] = 1;
    before[10] = after[10] = 1;
    before[15] = after[15] = 1;
    before[12] = 40;
    after[12] = 52;
    after[13] = -3;
    const velocity = springTransformVelocity(before, after, 0.02);
    expect(velocity[12]).toBe(600);
    expect(velocity[13]).toBe(-150);
    expect(velocity[0]).toBe(0);
    expect(velocity[15]).toBe(0);
  });

  it("does not manufacture momentum from invalid sampling intervals", () => {
    const matrix = new Float64Array(16);
    expect(springTransformVelocity(matrix, matrix, 0)).toEqual(Array(16).fill(0));
    expect(springTransformVelocity(matrix, matrix, Number.POSITIVE_INFINITY)).toEqual(Array(16).fill(0));
    expect(springTransformVelocity([], matrix, 0.02)).toEqual(Array(16).fill(0));
  });
});
