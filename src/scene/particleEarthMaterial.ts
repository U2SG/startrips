import {
  AdditiveBlending,
  BackSide,
  Color,
  ShaderMaterial,
  Vector3,
  type WebGLRenderer,
} from "three";
import { VISITED_IMPRINT_GAIN_CAP } from "./visitedImprint";

export const PARTICLE_DIM_POINT_LIMIT = 24;
export const PARTICLE_ACTIVE_DIM_POINT_LIMIT = 12;

/**
 * Exported for assertion: opt-in particle depth priority may move clip z only.
 * The facing term reaches zero at the silhouette and stays clamped to zero on
 * the far hemisphere so a biased point can never be pulled through the globe.
 */
export const PARTICLE_CLIP_DEPTH_BIAS_CHUNK = `
  vec3 particleDepthWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 particleDepthWorldNormal = normalize(mat3(modelMatrix) * normalize(transformed));
  float particleDepthFacing = clamp(
    dot(particleDepthWorldNormal, normalize(cameraPosition - particleDepthWorld)),
    0.0,
    1.0
  );
  gl_Position.z -= uClipDepthBias * particleDepthFacing * gl_Position.w;
`;

/**
 * Sizes are authored in CSS pixels, while gl_PointSize uses drawing-buffer
 * pixels. Read the effective renderer ratio, not window.devicePixelRatio,
 * so a quality cap changes sampling resolution rather than optical size.
 * A prototype method also survives ShaderMaterial.clone().
 *
 * This contract covers the current default framebuffer. A future offscreen
 * export pass must supply its own logical viewport / render-target scale.
 */
class ParticleEarthMaterial extends ShaderMaterial {
  override onBeforeRender(renderer: WebGLRenderer) {
    this.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  }
}

interface ParticleMaterialOptions {
  color: number;
  opacity: number;
  size: number;
  spatialLod?: boolean;
  radialPulseScale?: number;
  terrainRelief?: boolean;
  clipDepthBias?: number;
  visitedImprint?: boolean;
}

export function createParticleEarthMaterial({
  color,
  opacity,
  size,
  spatialLod = false,
  radialPulseScale = 1,
  terrainRelief = false,
  clipDepthBias = 0,
  visitedImprint = false,
}: ParticleMaterialOptions) {
  return new ParticleEarthMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: new Color(color) },
      uMorph: { value: 0 },
      uOpacity: { value: opacity },
      uPointSize: { value: size },
      uTime: { value: 0 },
      // Logical (CSS) height; physical scaling is owned by uPixelRatio.
      uViewportHeight: { value: 720 },
      uPixelRatio: { value: 1 },
      uDimPointCount: { value: 0 },
      uDimPoints: {
        value: Array.from({ length: PARTICLE_DIM_POINT_LIMIT }, () => new Vector3(0, 0, 1)),
      },
      uActiveDimPointCount: { value: 0 },
      uActiveDimPoints: {
        value: Array.from({ length: PARTICLE_ACTIVE_DIM_POINT_LIMIT }, () => new Vector3(0, 0, 1)),
      },
      uActiveDimStrength: { value: 0 },
      uLodProgress: { value: spatialLod ? 0 : 1 },
      uRadialPulseScale: { value: terrainRelief ? 0 : radialPulseScale },
      ...(clipDepthBias !== 0 ? { uClipDepthBias: { value: clipDepthBias } } : {}),
      ...(terrainRelief ? {
        uTerrainReliefMap: { value: null },
        uTerrainReliefEmphasis: { value: 0 },
      } : {}),
      ...(visitedImprint ? {
        uVisitedImprintMap: { value: null },
        uVisitedImprintGainCap: { value: VISITED_IMPRINT_GAIN_CAP },
        uVisitedImprintAttenuation: { value: 1 },
      } : {}),
      // Angular falloff is evaluated with dot products so attenuation stays
      // stable across zoom, DPR and screen size. 0.978 ~= 12°, 0.994 ~= 6°.
      uDimOuterCos: { value: 0.978 },
      uDimInnerCos: { value: 0.994 },
    },
    vertexShader: `
      attribute vec3 targetPosition;
      ${spatialLod ? "attribute float lodThreshold;" : ""}
      uniform float uMorph;
      uniform float uPointSize;
      uniform float uTime;
      uniform float uViewportHeight;
      uniform float uPixelRatio;
      uniform int uDimPointCount;
      uniform vec3 uDimPoints[${PARTICLE_DIM_POINT_LIMIT}];
      uniform int uActiveDimPointCount;
      uniform vec3 uActiveDimPoints[${PARTICLE_ACTIVE_DIM_POINT_LIMIT}];
      uniform float uActiveDimStrength;
      uniform float uDimOuterCos;
      uniform float uDimInnerCos;
      uniform float uLodProgress;
      uniform float uRadialPulseScale;
      ${clipDepthBias !== 0 ? "uniform float uClipDepthBias;" : ""}
      ${terrainRelief ? `
      uniform sampler2D uTerrainReliefMap;
      uniform float uTerrainReliefEmphasis;
      ` : ""}
      ${visitedImprint ? `
      uniform sampler2D uVisitedImprintMap;
      uniform float uVisitedImprintGainCap;
      uniform float uVisitedImprintAttenuation;
      ` : ""}
      varying float vStrength;
      varying float vTwinkle;
      varying float vDimBrightness;
      varying float vLodAlpha;

      float attenuationAt(vec3 direction, vec3 anchor) {
        // Anchor magnitude carries temporal reveal progress (0..1), while its
        // direction stays geographic. Hidden future points therefore cannot
        // leak a dark patch during Rewind, and partially revealed points fade
        // their suppression in with the same timeline progress.
        float revealStrength = length(anchor);
        if (revealStrength <= 0.0001) return 0.0;
        float alignment = dot(direction, anchor / revealStrength);
        return smoothstep(uDimOuterCos, uDimInnerCos, alignment)
          * clamp(revealStrength, 0.0, 1.0);
      }

      void main() {
        vec3 transformed = mix(position, targetPosition, uMorph);
        vec3 surfaceDirection = normalize(transformed);
        float nearbyJourney = 0.0;
        for (int index = 0; index < ${PARTICLE_DIM_POINT_LIMIT}; index += 1) {
          if (index >= uDimPointCount) break;
          nearbyJourney = max(nearbyJourney, attenuationAt(surfaceDirection, uDimPoints[index]));
        }
        float nearbyActiveJourney = 0.0;
        for (int index = 0; index < ${PARTICLE_ACTIVE_DIM_POINT_LIMIT}; index += 1) {
          if (index >= uActiveDimPointCount) break;
          nearbyActiveJourney = max(
            nearbyActiveJourney,
            attenuationAt(surfaceDirection, uActiveDimPoints[index])
          );
        }
        float dimAmount = clamp(
          max(nearbyJourney * 0.72, nearbyActiveJourney * 0.86 * uActiveDimStrength),
          0.0,
          1.0
        );
        float visitedImprintGain = 0.0;
        float visitedImprintStrength = 0.0;
        ${visitedImprint ? `
        // ST-020: sample the one cached low-resolution history field using the
        // same geographic direction as terrain relief. It changes only the
        // brightness/stability of existing particles; coordinates and size stay put.
        float imprintLongitudeAngle = length(surfaceDirection.xz) > 0.0001
          ? atan(surfaceDirection.z, -surfaceDirection.x) : 0.0;
        vec2 imprintUv = vec2(
          fract(imprintLongitudeAngle / 6.2831853),
          asin(clamp(surfaceDirection.y, -1.0, 1.0)) / 3.14159265 + 0.5
        );
        visitedImprintStrength = texture2D(uVisitedImprintMap, imprintUv).r;
        visitedImprintGain = visitedImprintStrength
          * uVisitedImprintGainCap
          * uVisitedImprintAttenuation
          * (1.0 - dimAmount * 0.85);
        ` : ""}

        float vertexId = float(gl_VertexID);
        float seed = fract(sin(vertexId * 12.9898) * 43758.5453);
        float pulse = sin(vertexId * 0.071 + uTime * 0.55) * 0.008;
        float shimmer = 0.5 + 0.5 * sin(
          uTime * (0.72 + seed * 1.18) + seed * 6.2831853
        );
        float spark = smoothstep(0.86, 0.995, shimmer) * step(0.68, seed);
        transformed *= 1.0 + pulse * uRadialPulseScale * mix(1.0, 0.3, dimAmount);
        float terrainEmphasis = 0.0;
        float terrainBrightness = 1.0;
        float terrainPointScale = 1.0;
        ${terrainRelief ? `
        if (uTerrainReliefEmphasis > 0.0) {
          // Geographic directions, rather than vertex IDs, keep both LOD
          // layers on the same fixed landforms without changing CPU coordinates.
          vec3 terrainDirection = normalize(position);
          float longitudeAngle = length(terrainDirection.xz) > 0.0001
            ? atan(terrainDirection.z, -terrainDirection.x) : 0.0;
          vec2 reliefUv = vec2(
            fract(longitudeAngle / 6.2831853),
            asin(clamp(terrainDirection.y, -1.0, 1.0)) / 3.14159265 + 0.5
          );
          // A four-pixel neighborhood joins the relief source's fine ridges
          // into readable landforms, with the same five texture fetches.
          vec2 texel = vec2(4.0 / 2048.0, 4.0 / 1024.0);
          float center = texture2D(uTerrainReliefMap, reliefUv).r;
          float east = texture2D(uTerrainReliefMap, reliefUv + vec2(texel.x, 0.0)).r;
          float west = texture2D(uTerrainReliefMap, reliefUv - vec2(texel.x, 0.0)).r;
          float north = texture2D(uTerrainReliefMap, reliefUv + vec2(0.0, texel.y)).r;
          float south = texture2D(uTerrainReliefMap, reliefUv - vec2(0.0, texel.y)).r;
          // Local range exposes mountain belts; the center's deviation from
          // its neighbors sculpts detail within them. Absolute gray level is
          // never altitude, and flat source regions stay flat.
          float low = min(center, min(min(east, west), min(north, south)));
          float high = max(center, max(max(east, west), max(north, south)));
          float localRange = high - low;
          float localMean = (east + west + north + south) * 0.25;
          float localDetail = smoothstep(-0.45, 0.45,
            (center - localMean) / max(localRange, 0.008));
          float structure = smoothstep(0.008, 0.09, localRange)
            * mix(0.55, 1.0, localDetail);
          // Zoom controls emphasis; a changed view reveals different real
          // texture structure. No clock or procedural wave moves the terrain.
          // Appearance only: particle centers must remain on the canonical
          // surface shared by routes, labels, picking, focus and Earth Dive.
          // Preserve the existing quiet corridor around route marks.
          terrainEmphasis = clamp(uTerrainReliefEmphasis, 0.0, 1.0)
            * (1.0 - uMorph) * mix(1.0, 0.18, dimAmount);
          terrainBrightness = mix(1.0, mix(0.72, 1.8, structure), terrainEmphasis);
          terrainPointScale = mix(1.0, mix(0.82, 1.2, structure), terrainEmphasis);
        }
        ` : ""}
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        ${clipDepthBias !== 0 ? PARTICLE_CLIP_DEPTH_BIAS_CHUNK : ""}

        float twinkleSignal = shimmer * 0.3 + spark * 0.95;
        float baseTwinkle = mix(0.78 + twinkleSignal * mix(1.0, 0.24, dimAmount),
          1.0, terrainEmphasis * 0.72);
        vTwinkle = mix(baseTwinkle, 1.0, visitedImprintStrength * 0.22);
        vDimBrightness = mix(1.0, 0.46, dimAmount)
          * terrainBrightness
          * (1.0 + visitedImprintGain);
        ${spatialLod
          ? "vLodAlpha = smoothstep(lodThreshold - 0.035, lodThreshold + 0.015, uLodProgress);"
          : "vLodAlpha = 1.0;"}
        gl_PointSize = max(
          1.0,
          uPointSize * (uViewportHeight / 720.0) * (1.7 / -mvPosition.z)
            * (0.9 + spark * 0.32 * mix(1.0, 0.28, dimAmount) * (1.0 - terrainEmphasis * 0.72))
            * terrainPointScale
        ) * uPixelRatio;
        vStrength = mix(1.0, 0.72, uMorph);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vStrength;
      varying float vTwinkle;
      varying float vDimBrightness;
      varying float vLodAlpha;

      void main() {
        float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
        float core = 1.0 - smoothstep(0.08, 0.48, distanceToCenter);
        float halo = 1.0 - smoothstep(0.18, 0.5, distanceToCenter);
        float alpha = (core * 0.84 + halo * 0.32)
          * uOpacity
          * vStrength
          * vTwinkle
          * vDimBrightness
          * vLodAlpha;
        if (alpha < 0.015) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}

export function createAtmosphereMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: BackSide,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: new Color(0x39d7cf) },
      uOpacity: { value: 0.42 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewPosition;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewPosition = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vViewPosition;

      void main() {
        float rim = pow(1.0 - abs(dot(vNormal, vViewPosition)), 2.3);
        gl_FragColor = vec4(uColor, rim * uOpacity);
      }
    `,
  });
}
