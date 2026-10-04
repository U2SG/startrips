import type { WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";
import { GLOBE_MODE_CONFIG } from "./globeMode";
import {
  ATMOSPHERE_DAY_NIGHT_CHUNK,
  PARTICLE_CLIP_DEPTH_BIAS_CHUNK,
  PARTICLE_DAY_NIGHT_CHUNK,
  createAtmosphereMaterial,
  createParticleEarthMaterial,
} from "./particleEarthMaterial";
import { DAY_NIGHT_NIGHT_BRIGHTNESS } from "./sunPosition";

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

  it("keeps clip depth bias opt-in and changes only clip-space z", () => {
    const plain = createParticleEarthMaterial({ color: 0xffffff, opacity: 1, size: 8 });
    const biased = createParticleEarthMaterial({
      color: 0xffffff, opacity: 1, size: 8, clipDepthBias: 0.0015,
    });
    try {
      expect(plain.vertexShader).not.toContain(PARTICLE_CLIP_DEPTH_BIAS_CHUNK);
      expect(plain.uniforms.uClipDepthBias).toBeUndefined();
      expect(biased.vertexShader).toContain(PARTICLE_CLIP_DEPTH_BIAS_CHUNK);
      expect(biased.uniforms.uClipDepthBias.value).toBe(0.0015);
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("gl_Position.z -=");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("gl_Position.w");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("particleDepthFacing");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("cameraPosition - particleDepthWorld");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("clamp(");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("0.0");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).toContain("1.0");
      expect(PARTICLE_CLIP_DEPTH_BIAS_CHUNK).not.toMatch(/gl_Position\.(x|y|w)\s*[-+*\/]?=/);
    } finally { plain.dispose(); biased.dispose(); }
  });

  it("compiles day/night uniforms only when the option is on", () => {
    const options = { color: 0xffffff, opacity: 1, size: 8, terrainRelief: true, visitedImprint: true };
    const plain = createParticleEarthMaterial(options);
    const lit = createParticleEarthMaterial({ ...options, dayNight: true });
    const atmosphere = createAtmosphereMaterial();
    const litAtmosphere = createAtmosphereMaterial({ dayNight: true });
    try {
      for (const material of [plain, atmosphere]) {
        expect(material.uniforms.uSunDirection).toBeUndefined();
        expect(material.uniforms.uDayNightStrength).toBeUndefined();
        expect(material.vertexShader + material.fragmentShader).not.toContain("uSunDirection");
      }
      expect(plain.vertexShader).not.toContain(PARTICLE_DAY_NIGHT_CHUNK);
      expect(atmosphere.fragmentShader).not.toContain(ATMOSPHERE_DAY_NIGHT_CHUNK);

      expect(lit.uniforms.uDayNightStrength.value).toBe(0);
      expect(lit.uniforms.uSunDirection.value.length()).toBeCloseTo(1, 10);
      expect(lit.vertexShader).toContain("uniform vec3 uSunDirection;");
      expect(lit.vertexShader).toContain(PARTICLE_DAY_NIGHT_CHUNK);
      expect(litAtmosphere.uniforms.uDayNightStrength.value).toBe(0);
      expect(litAtmosphere.fragmentShader).toContain(ATMOSPHERE_DAY_NIGHT_CHUNK);

      // Appearance only: the projection stays byte-identical.
      const positionAssignments = (shader: string) => shader.match(
        /\b(?:transformed|mvPosition|gl_Position)(?:\.[xyzwrgba]+)?\s*(?:[+*/-]?=)\s*[^;]+;/g,
      );
      expect(positionAssignments(lit.vertexShader)).toEqual(positionAssignments(plain.vertexShader));
      // Uses the geographic direction (shared by both LOD layers), releases
      // with the burst morph, and only ever multiplies brightness down.
      expect(PARTICLE_DAY_NIGHT_CHUNK).toContain("normalize(position)");
      expect(PARTICLE_DAY_NIGHT_CHUNK).toContain("(1.0 - uMorph)");
      expect(PARTICLE_DAY_NIGHT_CHUNK).toContain("vDimBrightness *= mix(");
      expect(PARTICLE_DAY_NIGHT_CHUNK).toMatch(
        new RegExp(`mix\\(\\s*1\\.0,\\s*${DAY_NIGHT_NIGHT_BRIGHTNESS.toFixed(2).replace(".", "\\.")},`),
      );
      expect(ATMOSPHERE_DAY_NIGHT_CHUNK).toContain("rim *= mix(");
    } finally {
      plain.dispose(); lit.dispose(); atmosphere.dispose(); litAtmosphere.dispose();
    }
  });

  it("keeps the faintest night-side particle above the discard threshold", () => {
    // Particle centre alpha = (0.84 + 0.32) * opacity * strength * twinkle
    // * dim * terrain. Worst case on the default home globe: the refinement
    // layer (half base opacity), darkest twinkle (0.78), and the darkest
    // combined journey dim (max 0.86 -> 0.536) with its capped terrain
    // emphasis (0.295 -> 0.917).
    const refinementOpacity = GLOBE_MODE_CONFIG.particleSphere.particleOpacity * 0.5;
    const dim = 1 + (0.46 - 1) * 0.86;
    const terrain = 1 - 0.28 * (1 + (0.18 - 1) * 0.86);
    const faintest = 1.16 * refinementOpacity * 0.78 * dim * terrain;
    expect(faintest).toBeGreaterThan(0.015);
    expect(faintest * DAY_NIGHT_NIGHT_BRIGHTNESS).toBeGreaterThan(0.015);
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
