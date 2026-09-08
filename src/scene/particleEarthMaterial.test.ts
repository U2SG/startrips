import type { WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";
import { createParticleEarthMaterial } from "./particleEarthMaterial";

function rendererWithPixelRatio(ratio: number) {
  // Only this renderer capability is consumed; these tests allocate no WebGL context.
  return { getPixelRatio: () => ratio } as WebGLRenderer;
}

function createMaterial(spatialLod = false) {
  return createParticleEarthMaterial({ color: 0xffffff, opacity: 1, size: 8, spatialLod });
}

describe("particle earth material", () => {
  it.each([false, true])("keeps terrain on the canonical surface with spatial LOD %s", (spatialLod) => {
    const options = { color: 0xffffff, opacity: 1, size: 8, spatialLod };
    const plain = createParticleEarthMaterial(options);
    const terrain = createParticleEarthMaterial({ ...options, terrainRelief: true });
    try {
      // Compare every position-affecting assignment, not a particular lift
      // variable name. Relief may change appearance, never the projection.
      const positionAssignments = (shader: string) => shader.match(
        /\b(?:transformed|mvPosition|gl_Position)(?:\.[xyzwrgba]+)?\s*(?:[+*/-]?=)\s*[^;]+;/g,
      );
      expect(positionAssignments(terrain.vertexShader)).toEqual(positionAssignments(plain.vertexShader));
      // Terrain also disables the generic star pulse even if callers omit it.
      expect(terrain.uniforms.uRadialPulseScale.value).toBe(0);
      expect(terrain.vertexShader).toContain("* terrainBrightness");
      expect(terrain.vertexShader).toContain("* terrainPointScale");
    } finally { plain.dispose(); terrain.dispose(); }
  });

  it("can disable world-space radial pulse for geographic signals", () => {
    const material = createParticleEarthMaterial({
      color: 0xffffff, opacity: 1, size: 8, radialPulseScale: 0,
    });
    expect(material.uniforms.uRadialPulseScale.value).toBe(0);
    material.dispose();
  });

  it.each([1, 1.25, 1.5, 2, 3])("uses effective renderer DPR %s instead of assuming one device pixel is one CSS pixel", (ratio) => {
    const material = createMaterial();
    try {
      expect(material.uniforms.uPixelRatio.value).toBe(1);
      material.onBeforeRender(rendererWithPixelRatio(ratio));
      expect(material.uniforms.uPixelRatio.value).toBe(ratio);
      expect(material.uniforms.uViewportHeight.value).toBe(720);
      // Shader contract, not a GPU rasterization test. Pixel-size limits and
      // additive brightness still need same-center browser captures.
      expect(material.vertexShader).toContain("uniform float uPixelRatio;");
      expect(material.vertexShader).toMatch(/gl_PointSize = max\([\s\S]*?\) \* uPixelRatio;/);
    } finally { material.dispose(); }
  });

  it("tracks high-to-low quality changes before drawing, without replacing uniforms", () => {
    const material = createMaterial();
    const ratioUniform = material.uniforms.uPixelRatio;
    try {
      material.onBeforeRender(rendererWithPixelRatio(3));
      material.onBeforeRender(rendererWithPixelRatio(1));
      expect(ratioUniform.value).toBe(1);
      expect(material.uniforms.uPixelRatio).toBe(ratioUniform);
    } finally { material.dispose(); }
  });

  it("applies the same pixel contract to a newly arrived spatial LOD material", () => {
    const material = createMaterial(true);
    try {
      material.onBeforeRender(rendererWithPixelRatio(2));
      expect(material.uniforms.uPixelRatio.value).toBe(2);
      expect(material.uniforms.uLodProgress.value).toBe(0);
      expect(material.vertexShader).toContain("attribute float lodThreshold;");
    } finally { material.dispose(); }
  });

  it("keeps the renderer hook after cloning and does not share mutable uniforms", () => {
    const original = createMaterial();
    const clone = original.clone();
    try {
      clone.onBeforeRender(rendererWithPixelRatio(2));
      expect(clone.uniforms.uPixelRatio.value).toBe(2);
      expect(original.uniforms.uPixelRatio.value).toBe(1);
      expect(clone.uniforms.uPixelRatio).not.toBe(original.uniforms.uPixelRatio);
    } finally { original.dispose(); clone.dispose(); }
  });
});
