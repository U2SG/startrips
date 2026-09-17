import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgedDiveWheel, DIVE_FIXTURE_PARK_PROGRESS, nextDiveFixtureInput } from "./qa-earth-dive-input.mjs";
import { EARTH_DIVE_BLEND_ENTER_PROGRESS, EARTH_DIVE_DETAIL_ENTER_PROGRESS } from "../src/scene/earthDive.ts";
import { LOCAL_BAND_ENTRY_ZOOM, GLOBE_SEMANTIC_ZOOM_CEILING, localBandProgress } from "../src/scene/semanticZoom.ts";

afterEach(() => vi.unstubAllGlobals());
describe("native Earth Dive fixture input", () => {
  it("parks strictly inside the authoritative blend band even after one fine notch", () => {
    expect(DIVE_FIXTURE_PARK_PROGRESS).toBeGreaterThan(EARTH_DIVE_BLEND_ENTER_PROGRESS);
    expect(DIVE_FIXTURE_PARK_PROGRESS).toBeLessThan(EARTH_DIVE_DETAIL_ENTER_PROGRESS);
    const zoom = LOCAL_BAND_ENTRY_ZOOM + (GLOBE_SEMANTIC_ZOOM_CEILING - LOCAL_BAND_ENTRY_ZOOM) * DIVE_FIXTURE_PARK_PROGRESS;
    expect(localBandProgress(zoom * Math.exp(10 * 0.0012))).toBeLessThan(EARTH_DIVE_DETAIL_ENTER_PROGRESS);
  });
  it("uses a fine notch before local instead of crossing its entire band", () => {
    expect(nextDiveFixtureInput({semanticZoom:"regional"}, -120, -10)).toEqual({kind:"wheel",deltaY:-10});
  });
  it("holds input while an unready map catches up inside blending", () => {
    expect(nextDiveFixtureInput({stage:"prewarm",semanticZoom:"local",localProgress:"0.65"},-10,-10,true)).toEqual({kind:"wait-blending"});
  });
  it("does not keep zooming or claim success after detail already owns the view", () => {
    expect(() => nextDiveFixtureInput({stage:"detail",semanticZoom:"local",localProgress:1},-10,-10,true)).toThrow(/passed blending/);
  });
  it("preserves blocked-style deep zoom and reverse input coverage", () => {
    expect(nextDiveFixtureInput({stage:"prewarm",semanticZoom:"local",localProgress:.8},-120,-10,false)).toEqual({kind:"wheel",deltaY:-120});
    expect(nextDiveFixtureInput({stage:"detail",semanticZoom:"regional"},240,-10,false)).toEqual({kind:"wheel",deltaY:240});
  });
  it("acknowledges exactly one real wheel before renderer frames, without a sleep", async () => {
    const order=[];
    vi.stubGlobal("window",{__qaEarthDiveWheelEvents:new Array(4)});
    vi.stubGlobal("requestAnimationFrame",callback => {order.push("frame");queueMicrotask(callback);});
    const page={mouse:{move:vi.fn(async()=>order.push("move")),wheel:vi.fn(async()=>order.push("native-wheel"))},
      evaluate:vi.fn(async fn=>fn()),
      waitForFunction:vi.fn(async(fn,before)=>{order.push("ack");expect(fn(before)).toBe(false);window.__qaEarthDiveWheelEvents.push({});expect(fn(before)).toBe(true);})};
    await acknowledgedDiveWheel(page,{x:10,y:20},-10);
    expect(page.mouse.wheel).toHaveBeenCalledExactlyOnceWith(0,-10);
    expect(order).toEqual(["move","native-wheel","ack","frame","frame"]);
  });
  it("fails ignored native input without retrying a gesture", async()=>{
    const page={mouse:{move:vi.fn(),wheel:vi.fn()},evaluate:vi.fn(async()=>0),waitForFunction:vi.fn(async()=>{throw new Error("native delivery missing");})};
    await expect(acknowledgedDiveWheel(page,{x:1,y:1},-10)).rejects.toThrow(/delivery missing/);
    expect(page.mouse.wheel).toHaveBeenCalledTimes(1);
  });
  it("requires recorder evidence before sending input",async()=>{
    const page={mouse:{move:vi.fn(),wheel:vi.fn()},evaluate:vi.fn(async()=>null)};
    await expect(acknowledgedDiveWheel(page,{x:1,y:1},-10)).rejects.toThrow(/recorder/);
    expect(page.mouse.wheel).not.toHaveBeenCalled();
  });
});
