import { describe, expect, it } from "vitest";
import { ArrivalParticles, ARRIVAL_PARTICLE_VERTEX } from "./arrivalParticles";
import { createParticleEarthMaterial } from "./particleEarthMaterial";

describe("first-arrival decoration", () => {
  it("returns to zero without a timer and cannot replay after cancellation", () => {
    const state = new ArrivalParticles();
    state.start(true);
    for (let i = 0; i < 30; i++) state.step(1 / 60, true);
    expect(state.glow).toBeGreaterThan(0.5);
    state.cancel();
    state.step(1 / 60, true);
    expect([state.phase, state.glow, state.twist]).toEqual(["idle", 0, 0]);
    state.start(true);
    for (let i = 0; i < 300; i++) state.step(1 / 60, true);
    expect([state.phase, state.glow, state.twist]).toEqual(["idle", 0, 0]);
  });

  it("degrades an in-flight response to static light without replay on upgrade", () => {
    const state = new ArrivalParticles();
    state.start(true);
    state.step(0.05, true);
    state.step(0, false);
    const glow = state.glow;
    expect(state.phase).toBe("static");
    expect(state.twist).toBe(0);
    state.step(0.05, true);
    expect([state.phase, state.glow, state.twist]).toEqual(["static", glow, 0]);
    state.cancel();
    expect(state.glow).toBe(0);
    state.start(false);
    expect([state.phase, state.glow, state.twist]).toEqual(["static", glow, 0]);
  });

  it("keeps the same spring response across the release boundary at 30/60/120Hz", () => {
    const samples = [30, 60, 120].map((hz) => {
      const state = new ArrivalParticles();
      state.start(true);
      for (let i = 0; i < hz * 0.8; i++) state.step(1 / hz, true);
      return state.glow;
    });
    expect(samples[0]).toBeCloseTo(samples[1], 10);
    expect(samples[1]).toBeCloseTo(samples[2], 10);
  });

  it("leaves default/geographic shaders untouched and opts only decoration into the field", () => {
    const options = { color: 0xffffff, opacity: 0.18, size: 8 };
    const base = createParticleEarthMaterial(options);
    const land = createParticleEarthMaterial({ ...options, terrainRelief: true, spatialLod: true });
    const shell = createParticleEarthMaterial({ ...options, arrivalParticles: true });
    try {
      for (const material of [base, land]) {
        expect(material.vertexShader).not.toContain(ARRIVAL_PARTICLE_VERTEX);
        expect(material.uniforms.uArrivalTwist).toBeUndefined();
      }
      expect(shell.vertexShader).toContain(ARRIVAL_PARTICLE_VERTEX);
      expect(shell.uniforms.uArrivalTwist.value).toBe(0);
      expect(shell.uniforms.uArrivalGlow.value).toBe(0);
    } finally { base.dispose(); land.dispose(); shell.dispose(); }
  });
});
