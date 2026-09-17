import { afterEach, describe, expect, it, vi } from "vitest";
import { setParticleZoom } from "./qa-particle-zoom.mjs";

function fixture({ initial = 1.4, flightZoom = 1.7, accepts = true, scale = 1, connected = true, width = 1280, frameDrift = 0 } = {}) {
  let zoom = initial;
  const events = [];
  vi.stubGlobal("window", { __particleEarthDebug: () => ({ zoom, semanticLod: "planet" }) });
  vi.stubGlobal("WheelEvent", class {
    constructor(type, options) { this.type = type; Object.assign(this, options); this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  });
  let frames = 0;
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    frames += 1;
    queueMicrotask(() => { if (frames === 2) zoom += frameDrift; callback(16 * frames); });
  });
  const node = {
    isConnected: connected,
    getBoundingClientRect: () => ({ x: 10, y: 20, width, height: 800 }),
    dispatchEvent(event) {
      events.push(event);
      if (accepts) { event.preventDefault(); zoom *= Math.exp(-event.deltaY * 0.0012) * scale; }
      return !event.defaultPrevented;
    },
  };
  const evaluate = vi.fn((callback, argument) => {
    // The focus animation moves before the browser handles our command. A
    // pre-read on the host would now be stale, even with a fixed sleep afterward.
    zoom = flightZoom;
    return callback(node, argument);
  });
  const page = { locator: vi.fn(() => ({ evaluate })), evaluate: vi.fn(() => { throw new Error("stale host read"); }) };
  return { page, events, evaluate };
}

afterEach(() => vi.unstubAllGlobals());

describe("atomic particle QA zoom fixture input", () => {
  it("uses current browser zoom after an intervening focus-flight frame", async () => {
    const { page, events, evaluate } = fixture();
    await expect(setParticleZoom(page, 1)).resolves.toMatchObject({ zoom: 1 });
    expect(evaluate).toHaveBeenCalledTimes(1); expect(page.evaluate).not.toHaveBeenCalled();
    expect(events).toHaveLength(1); expect(events[0].deltaY).toBeCloseTo(-Math.log(1 / 1.7) / 0.0012);
  });
  it("claims manual ownership even when already exactly at target", async () => {
    const { page, events } = fixture({ flightZoom: 1 });
    await setParticleZoom(page, 1); expect(events).toHaveLength(1); expect(events[0].deltaY).toEqual(-0);
  });
  it("uses canvas-relative client bounds without another protocol round trip", async () => {
    const { page, events } = fixture(); await setParticleZoom(page, 2);
    expect(events[0]).toMatchObject({ clientX: 650, clientY: 420, bubbles: true, cancelable: true });
  });
  it("preserves a caller's geographic anchor screen position", async () => {
    const { page, events } = fixture(); await setParticleZoom(page, 3, { x: 83, y: 145 });
    expect(events[0]).toMatchObject({ clientX: 83, clientY: 145 });
  });
  it("rejects ignored input even when zoom happens to equal target", async () => {
    const { page, events } = fixture({ accepts: false, flightZoom: 1 });
    await expect(setParticleZoom(page, 1)).rejects.toThrow(/not applied exactly/); expect(events).toHaveLength(1);
  });
  it("does not retry a wheel handler that applies the wrong zoom", async () => {
    const { page, events } = fixture({ scale: 1.1028 });
    await expect(setParticleZoom(page, 1)).rejects.toThrow(/not applied exactly/); expect(events).toHaveLength(1);
  });
  it("still rejects a later owner overriding the requested zoom", async () => {
    const { page, events } = fixture({ frameDrift: 0.2 });
    await expect(setParticleZoom(page, 1)).rejects.toThrow(/changed after input/); expect(events).toHaveLength(1);
  });
  it("refuses missing debug state rather than treating it as default zoom", async () => {
    const { page } = fixture(); window.__particleEarthDebug = () => null;
    await expect(setParticleZoom(page, 1)).rejects.toThrow(/unavailable/);
  });
  it.each([0, -1, NaN, Infinity])("refuses invalid target %s without input", async (value) => {
    const { page, events } = fixture(); await expect(setParticleZoom(page, value)).rejects.toThrow(/finite and positive/);
    expect(events).toHaveLength(0);
  });
  it.each([{ connected: false }, { width: 0 }])("refuses unavailable canvas %o", async (options) => {
    const { page, events } = fixture(options); await expect(setParticleZoom(page, 1)).rejects.toThrow(/connected bounds/);
    expect(events).toHaveLength(0);
  });
});
