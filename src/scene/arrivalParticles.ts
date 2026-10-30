import { stepSpring, type SpringValue } from "../motion/springElement";
import { motionTokens } from "../motion/tokens";

export type ArrivalExperiment = "bloom" | "particles";

/** Presentation only. The existing first-arrival revision owns start/cancel. */
export class ArrivalParticles {
  phase: "idle" | "moving" | "static" = "idle";
  age = 0;
  glow = 0;
  twist = 0;
  private spring: SpringValue = { position: 0, velocity: 0 };

  start(animate: boolean) {
    this.cancel();
    this.phase = animate ? "moving" : "static";
    if (!animate) this.glow = motionTokens.glow.haloOpacity;
  }

  cancel() {
    this.phase = "idle";
    this.age = this.glow = this.twist = 0;
    this.spring.position = this.spring.velocity = 0;
  }

  step(seconds: number, animate: boolean) {
    if (this.phase !== "moving") return;
    if (!animate) {
      // Changing preference/quality completes the spatial response. Re-enabling
      // motion cannot replay a consumed arrival.
      this.phase = "static";
      this.twist = 0;
      this.glow = motionTokens.glow.haloOpacity;
      this.spring.position = this.spring.velocity = 0;
      return;
    }
    const dt = Math.max(0, Math.min(0.05, seconds));
    const hold = motionTokens.tiers.content / 1000;
    // Split the step at the target change, so different frame rates share the
    // same spring trajectory instead of moving its release by a whole frame.
    const rise = Math.min(dt, Math.max(0, hold - this.age));
    this.spring = stepSpring(this.spring, 1, rise);
    this.spring = stepSpring(this.spring, 0, dt - rise);
    this.age += dt;
    this.glow = Math.max(0, Math.min(1, this.spring.position));
    this.twist = this.glow;
    if (this.age >= hold && Math.abs(this.spring.position) < 0.001
      && Math.abs(this.spring.velocity) < 0.001) this.cancel();
  }
}

// Original analytic tangent field; inspired by Particle Love's local particle
// motion, without copying its shaders or importing its r74/r76 render pipeline.
// Only the decorative shell opts in. Geographic materials never include this.
export const ARRIVAL_PARTICLE_UNIFORMS = `
  uniform vec3 uArrivalAnchor;
  uniform float uArrivalTwist;
  uniform float uArrivalGlow;
  varying float vArrivalGlow;
`;

export const ARRIVAL_PARTICLE_VERTEX = `
  float arrivalAlignment = dot(surfaceDirection, uArrivalAnchor);
  float arrivalRegion = smoothstep(0.90, 0.985, arrivalAlignment);
  // Leave the exact anchor quiet; the mark and its hit target remain the lead.
  float arrivalRing = arrivalRegion * (1.0 - smoothstep(0.995, 1.0, arrivalAlignment));
  vec3 arrivalTangent = cross(uArrivalAnchor, surfaceDirection);
  // This perturbation is tangent to the shell; renormalizing keeps its radius.
  // No pointer projection, geographic buffer or CPU coordinate consumes it.
  transformed = length(transformed) * normalize(surfaceDirection
    + arrivalTangent * (0.42 * uArrivalTwist * arrivalRing));
  vArrivalGlow = arrivalRing * uArrivalGlow;
`;
