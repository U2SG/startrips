import { describe, expect, it } from "vitest";
import { createParticleEarthMaterial } from "./particleEarthMaterial";

describe("particle earth material", () => {
  it("can disable world-space radial pulse for geographic signals", () => {
    const material = createParticleEarthMaterial({
      color: 0xffffff,
      opacity: 1,
      size: 8,
      radialPulseScale: 0,
    });

    expect(material.uniforms.uRadialPulseScale.value).toBe(0);
    material.dispose();
  });
});
