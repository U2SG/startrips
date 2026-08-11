import {
  AdditiveBlending,
  BackSide,
  Color,
  ShaderMaterial,
} from "three";

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
    },
    vertexShader: `
      attribute vec3 targetPosition;
      uniform float uMorph;
      uniform float uPointSize;
      uniform float uTime;
      uniform float uViewportHeight;
      varying float vStrength;

      void main() {
        vec3 transformed = mix(position, targetPosition, uMorph);
        float pulse = sin(float(gl_VertexID) * 0.071 + uTime * 0.55) * 0.008;
        transformed *= 1.0 + pulse;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = max(1.0, uPointSize * (uViewportHeight / 720.0) * (1.7 / -mvPosition.z));
        vStrength = mix(1.0, 0.72, uMorph);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vStrength;

      void main() {
        float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
        float core = 1.0 - smoothstep(0.08, 0.48, distanceToCenter);
        float halo = 1.0 - smoothstep(0.18, 0.5, distanceToCenter);
        float alpha = (core * 0.84 + halo * 0.32) * uOpacity * vStrength;
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
