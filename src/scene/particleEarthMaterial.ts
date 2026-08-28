import {
  AdditiveBlending,
  BackSide,
  Color,
  ShaderMaterial,
  Vector3,
} from "three";

export const PARTICLE_DIM_POINT_LIMIT = 24;
export const PARTICLE_ACTIVE_DIM_POINT_LIMIT = 12;

interface ParticleMaterialOptions {
  color: number;
  opacity: number;
  size: number;
}

export function createParticleEarthMaterial({
  color,
  opacity,
  size,
}: ParticleMaterialOptions) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: new Color(color) },
      uMorph: { value: 0 },
      uOpacity: { value: opacity },
      uPointSize: { value: size },
      uTime: { value: 0 },
      uViewportHeight: { value: 720 },
      uDimPointCount: { value: 0 },
      uDimPoints: {
        value: Array.from({ length: PARTICLE_DIM_POINT_LIMIT }, () => new Vector3(0, 0, 1)),
      },
      uActiveDimPointCount: { value: 0 },
      uActiveDimPoints: {
        value: Array.from({ length: PARTICLE_ACTIVE_DIM_POINT_LIMIT }, () => new Vector3(0, 0, 1)),
      },
      uActiveDimStrength: { value: 0 },
      // Angular falloff is evaluated with dot products so attenuation stays
      // stable across zoom, DPR and screen size. 0.978 ~= 12°, 0.994 ~= 6°.
      uDimOuterCos: { value: 0.978 },
      uDimInnerCos: { value: 0.994 },
    },
    vertexShader: `
      attribute vec3 targetPosition;
      uniform float uMorph;
      uniform float uPointSize;
      uniform float uTime;
      uniform float uViewportHeight;
      uniform int uDimPointCount;
      uniform vec3 uDimPoints[${PARTICLE_DIM_POINT_LIMIT}];
      uniform int uActiveDimPointCount;
      uniform vec3 uActiveDimPoints[${PARTICLE_ACTIVE_DIM_POINT_LIMIT}];
      uniform float uActiveDimStrength;
      uniform float uDimOuterCos;
      uniform float uDimInnerCos;
      varying float vStrength;
      varying float vTwinkle;
      varying float vDimBrightness;

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

        float vertexId = float(gl_VertexID);
        float seed = fract(sin(vertexId * 12.9898) * 43758.5453);
        float pulse = sin(vertexId * 0.071 + uTime * 0.55) * 0.008;
        float shimmer = 0.5 + 0.5 * sin(
          uTime * (0.72 + seed * 1.18) + seed * 6.2831853
        );
        float spark = smoothstep(0.86, 0.995, shimmer) * step(0.68, seed);
        transformed *= 1.0 + pulse * mix(1.0, 0.3, dimAmount);
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float twinkleSignal = shimmer * 0.3 + spark * 0.95;
        vTwinkle = 0.78 + twinkleSignal * mix(1.0, 0.24, dimAmount);
        vDimBrightness = mix(1.0, 0.46, dimAmount);
        gl_PointSize = max(
          1.0,
          uPointSize * (uViewportHeight / 720.0) * (1.7 / -mvPosition.z)
            * (0.9 + spark * 0.32 * mix(1.0, 0.28, dimAmount))
        );
        vStrength = mix(1.0, 0.72, uMorph);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vStrength;
      varying float vTwinkle;
      varying float vDimBrightness;

      void main() {
        float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
        float core = 1.0 - smoothstep(0.08, 0.48, distanceToCenter);
        float halo = 1.0 - smoothstep(0.18, 0.5, distanceToCenter);
        float alpha = (core * 0.84 + halo * 0.32)
          * uOpacity
          * vStrength
          * vTwinkle
          * vDimBrightness;
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
