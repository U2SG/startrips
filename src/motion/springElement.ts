import { onMotionPreferenceChange, prefersReducedMotion } from "./preferences";
import { motionTokens } from "./tokens";

export type SpringValue = { position: number; velocity: number };
export type SpringElementTarget = { transform: string; opacity?: number };
export type SpringElementOptions = {
  owner?: string;
  stiffness?: number;
  damping?: number;
  /** Sixteen DOMMatrix components per second, in toFloat64Array() order. */
  transformVelocity?: ArrayLike<number>;
};
export type SpringElementHandle = { finished: Promise<void>; cancel(): void };

/** Derive release momentum from two painted transform samples. */
export function springTransformVelocity(from: ArrayLike<number>, to: ArrayLike<number>, seconds: number): number[] {
  if (from.length !== 16 || to.length !== 16 || !(seconds > 0) || !Number.isFinite(seconds)) return Array(16).fill(0);
  return Array.from({ length: 16 }, (_, index) => {
    const velocity = (to[index] - from[index]) / seconds;
    return Number.isFinite(velocity) ? velocity : 0;
  });
}

/** Exact solution of a unit-mass damped spring, with time measured in seconds. */
export function stepSpring(
  value: SpringValue, target: number, seconds: number,
  stiffness: number = motionTokens.spring.stiffness, damping: number = motionTokens.spring.damping,
): SpringValue {
  if (!(seconds > 0)) return { ...value };
  const offset = value.position - target;
  const decay = damping / 2;
  const discriminant = decay * decay - stiffness;
  if (Math.abs(discriminant) < 1e-8) {
    const envelope = Math.exp(-decay * seconds);
    const change = value.velocity + decay * offset;
    return {
      position: target + envelope * (offset + change * seconds),
      velocity: envelope * (value.velocity - decay * change * seconds),
    };
  }
  if (discriminant < 0) {
    const frequency = Math.sqrt(-discriminant);
    const phase = frequency * seconds;
    const sine = Math.sin(phase);
    const cosine = Math.cos(phase);
    const envelope = Math.exp(-decay * seconds);
    return {
      position: target + envelope * (offset * cosine + (value.velocity + decay * offset) / frequency * sine),
      velocity: envelope * (value.velocity * cosine - (decay * value.velocity + stiffness * offset) / frequency * sine),
    };
  }
  const root = Math.sqrt(discriminant);
  const slow = -stiffness / (decay + root);
  const fast = -decay - root;
  const a = (value.velocity - fast * offset) / (slow - fast);
  const b = offset - a;
  const first = a * Math.exp(slow * seconds);
  const second = b * Math.exp(fast * seconds);
  return { position: target + first + second, velocity: slow * first + fast * second };
}

type Run = { resolve(): void; reject(reason: Error): void };
type ElementSpring = {
  element: HTMLElement;
  owner: string | undefined;
  current: number[];
  velocity: number[];
  target: number[];
  expression: SpringElementTarget;
  opacityStyle: string;
  opacityPriority: string;
  transitionStyle: string;
  transitionPriority: string;
  stiffness: number;
  damping: number;
  time: number;
  run: Run | null;
};

const springs = new WeakMap<HTMLElement, ElementSpring>();
const active = new Set<ElementSpring>();
let frame: number | null = null;
let stopPreference: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

function observeLayout(element: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return;
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const state = springs.get(entry.target as HTMLElement);
      if (!state?.run || !active.has(state)) continue;
      if (!state.element.isConnected) { cancel(state, state.run); continue; }
      // Matrix paint remains the current position; only the responsive target
      // changes. The existing rAF carries current momentum toward the new size.
      state.target = resolveTarget(state.element, state.expression, state.target[16]);
    }
  });
  resizeObserver.observe(element, { box: "border-box" });
}

function computedValues(element: HTMLElement): number[] {
  const style = getComputedStyle(element);
  const matrix = new DOMMatrixReadOnly(!style.transform || style.transform === "none" ? undefined : style.transform);
  return [...matrix.toFloat64Array(), Number.parseFloat(style.opacity) || 0];
}

function resolveTarget(element: HTMLElement, target: SpringElementTarget, opacity: number): number[] {
  const oldTransform = element.style.getPropertyValue("transform");
  const transformPriority = element.style.getPropertyPriority("transform");
  const oldTransition = element.style.getPropertyValue("transition");
  const transitionPriority = element.style.getPropertyPriority("transition");
  try {
    // Resolve percentages/calc against this element without leaving a temporary
    // style behind or launching a competing CSS transition.
    element.style.setProperty("transition", "none", "important");
    element.style.setProperty("transform", target.transform, "important");
    const values = computedValues(element);
    values[16] = target.opacity ?? opacity;
    return values;
  } finally {
    element.style.setProperty("transform", oldTransform, transformPriority);
    element.style.setProperty("transition", oldTransition, transitionPriority);
  }
}

function paint(state: ElementSpring) {
  state.element.style.transform = `matrix3d(${state.current.slice(0, 16).join(",")})`;
  state.element.style.opacity = String(Math.max(0, Math.min(1, state.current[16])));
}

function releaseScheduler() {
  if (active.size) return;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  stopPreference?.();
  stopPreference = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
}

function finish(state: ElementSpring) {
  const run = state.run;
  if (!run) return;
  state.run = null;
  active.delete(state);
  resizeObserver?.unobserve(state.element);
  state.current = [...state.target];
  state.velocity.fill(0);
  state.element.style.transform = state.expression.transform;
  if (state.expression.opacity !== undefined) state.element.style.opacity = String(state.expression.opacity);
  else state.element.style.setProperty("opacity", state.opacityStyle, state.opacityPriority);
  state.element.style.setProperty("transition", state.transitionStyle, state.transitionPriority);
  run.resolve();
  releaseScheduler();
}

function advance(state: ElementSpring, now: number) {
  const seconds = Math.max(0, (now - state.time) / 1000);
  state.time = now;
  let settled = true;
  for (let index = 0; index < state.current.length; index += 1) {
    const next = stepSpring({ position: state.current[index], velocity: state.velocity[index] },
      state.target[index], seconds, state.stiffness, state.damping);
    state.current[index] = next.position;
    state.velocity[index] = next.velocity;
    const translation = index >= 12 && index <= 14;
    if (Math.abs(next.position - state.target[index]) > (translation ? 0.1 : 0.0001)
      || Math.abs(next.velocity) > (translation ? 0.8 : 0.001)) settled = false;
  }
  paint(state);
  return settled;
}

function cancel(state: ElementSpring, run: Run) {
  if (state.run !== run) return;
  // Freeze at the cancellation instant, retaining velocity for the next intent.
  // A pointer handler can already have painted a new position in this event.
  const actual = computedValues(state.element);
  if (actual.every((value, index) => Math.abs(value - state.current[index]) < 0.0001)) {
    advance(state, performance.now());
  } else {
    state.current = actual;
    state.velocity.fill(0);
  }
  state.element.style.setProperty("transition", state.transitionStyle, state.transitionPriority);
  state.run = null;
  active.delete(state);
  resizeObserver?.unobserve(state.element);
  run.reject(new DOMException("Spring motion cancelled", "AbortError"));
  releaseScheduler();
}

function tick(now: number) {
  frame = null;
  for (const state of active) {
    if (!state.element.isConnected) { if (state.run) cancel(state, state.run); }
    else if (advance(state, now)) finish(state);
  }
  if (active.size) frame = requestAnimationFrame(tick);
}

/** Animate a visual element; keep its interactive hit area on a stable parent. */
export function springElementTo(
  element: HTMLElement, target: SpringElementTarget, options: SpringElementOptions = {},
): SpringElementHandle {
  const previous = springs.get(element);
  if (previous?.run) cancel(previous, previous.run);
  const current = computedValues(element);
  // Direct manipulation may have written a different transform after cancel.
  // Retain momentum only while this same owner still owns the painted state.
  const continuous = previous && previous.owner === options.owner
    && current.every((value, index) => Math.abs(value - previous.current[index]) < 0.0001);
  const state: ElementSpring = {
    element, owner: options.owner, current,
    velocity: continuous ? [...previous.velocity] : current.map(() => 0),
    target: resolveTarget(element, target, current[16]), expression: { ...target },
    opacityStyle: element.style.getPropertyValue("opacity"), opacityPriority: element.style.getPropertyPriority("opacity"),
    transitionStyle: element.style.getPropertyValue("transition"), transitionPriority: element.style.getPropertyPriority("transition"),
    stiffness: Number.isFinite(options.stiffness) && options.stiffness! > 0 ? options.stiffness! : motionTokens.spring.stiffness,
    damping: Number.isFinite(options.damping) && options.damping! > 0 ? options.damping! : motionTokens.spring.damping,
    time: performance.now(), run: null,
  };
  const suppliedVelocity = options.transformVelocity;
  if (suppliedVelocity?.length === 16 && Array.from(suppliedVelocity).every(Number.isFinite)) {
    for (let index = 0; index < 16; index += 1) state.velocity[index] = suppliedVelocity[index];
  }
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const finished = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  const run = { resolve, reject };
  state.run = run;
  springs.set(element, state);
  if (prefersReducedMotion()) finish(state);
  else {
    element.style.setProperty("transition", "none", "important");
    paint(state);
    active.add(state);
    observeLayout(element);
    if (!stopPreference) stopPreference = onMotionPreferenceChange((reduced) => {
      if (reduced) for (const running of active) finish(running);
    });
    if (frame === null) frame = requestAnimationFrame(tick);
  }
  return { finished, cancel: () => cancel(state, run) };
}
