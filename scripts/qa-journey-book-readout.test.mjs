import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded, settledBookSnapshot, flightBookSnapshot, waitForBookSnapshot } from "./qa-journey-book-readout.mjs";

const rectangle = { left: 30, top: 20, width: 900, height: 700 };
const book = { face: 78, spread: 39, sheets: 40, rects: { right: { left: 450, top: 50, width: 380, height: 520 } } };
const flight = { progress: 1.5, following: false, sheetTop: 2, live: { top: 3, bottom: 0 } };
function stageFor(dataset = {}) { return { dataset, getBoundingClientRect: vi.fn(() => ({ ...rectangle })) }; }
function inBrowser(fn, arg, getStage) {
  // Also proves the serialized page callback has no hidden module dependency.
  const document = { querySelector: vi.fn(() => getStage()) };
  const value = runInNewContext(`(${fn.toString()})(arg)`, { document, arg });
  expect(document.querySelector).toHaveBeenCalledOnce();
  expect(document.querySelector).toHaveBeenCalledWith(".journey-book-3d__stage");
  return value;
}
afterEach(() => vi.useRealTimers());

describe("atomic Journey Book QA snapshots", () => {
  it.each([null, stageFor(), stageFor({ qaBook: "" })])("waits without throwing when the settled readout is absent", (stage) => {
    expect(inBrowser(settledBookSnapshot, 78, () => stage)).toBe(false);
  });
  it("does not accept another face", () => {
    const stage = stageFor({ qaBook: JSON.stringify({ ...book, face: 76 }) });
    expect(inBrowser(settledBookSnapshot, 78, () => stage)).toBe(false);
    expect(stage.getBoundingClientRect).not.toHaveBeenCalled();
  });
  it("captures the matching face and its stage rect together", () => {
    const stage = stageFor({ qaBook: JSON.stringify(book) });
    expect(inBrowser(settledBookSnapshot, 78, () => stage)).toEqual({ ...book, stage: rectangle });
    expect(stage.getBoundingClientRect).toHaveBeenCalledOnce();
  });
  it("reads qaBook once even if the next access would see an unsettled stage", () => {
    let reads = 0;
    const stage = stageFor({ get qaBook() { return ++reads === 1 ? JSON.stringify(book) : undefined; } });
    expect(inBrowser(settledBookSnapshot, 78, () => stage)).toEqual({ ...book, stage: rectangle });
    expect(reads).toBe(1);
  });
  it.each(["undefined", "{broken"])('does not swallow malformed settled instrumentation: %s', (raw) => {
    expect(() => inBrowser(settledBookSnapshot, 78, () => stageFor({ qaBook: raw }))).toThrow();
  });
  it("flight capture enforces the existing progress and camera predicate", () => {
    expect(inBrowser(flightBookSnapshot, { want: 1.5, tol: 0.01 }, () => null)).toBe(false);
    for (const item of [{ ...flight, following: true }, { ...flight, progress: 1.8 }]) {
      expect(inBrowser(flightBookSnapshot, { want: 1.5, tol: 0.01 }, () => stageFor({ qaBookFlight: JSON.stringify(item) }))).toBe(false);
    }
    expect(inBrowser(flightBookSnapshot, { want: 1.5, tol: 0.01 }, () => stageFor({ qaBookFlight: JSON.stringify(flight) }))).toEqual(flight);
  });
  it("malformed flight instrumentation fails instead of returning fabricated data", () => {
    expect(() => inBrowser(flightBookSnapshot, { want: 1.5, tol: 0.01 }, () => stageFor({ qaBookFlight: "undefined" }))).toThrow();
  });
  it.each(["remove", "replace", "unmount"])("preserves the qualifying snapshot if the DOM changes after wait: %s", async (mutation) => {
    let current = stageFor({ qaBook: JSON.stringify(book) });
    const dispose = vi.fn(async () => {});
    const page = { waitForFunction: vi.fn(async (fn, arg) => {
      const captured = inBrowser(fn, arg, () => current);
      if (mutation === "remove") delete current.dataset.qaBook;
      if (mutation === "replace") current = stageFor({ qaBook: JSON.stringify({ ...book, face: 0 }) });
      if (mutation === "unmount") current = null;
      return { jsonValue: async () => structuredClone(captured), dispose };
    }), evaluate: vi.fn(() => { throw new Error("must not re-read DOM after wait"); }) };
    expect(await waitForBookSnapshot(page, "last spread", settledBookSnapshot, 78, 120_000, 30_000)).toEqual({ ...book, stage: rectangle });
    expect(page.waitForFunction).toHaveBeenCalledWith(settledBookSnapshot, 78, { timeout: 120_000 });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("propagates the original wait failure without a default snapshot or retry", async () => {
    const failure = new Error("never settled");
    const page = { waitForFunction: vi.fn(async () => { throw failure; }) };
    await expect(waitForBookSnapshot(page, "last spread", settledBookSnapshot, 78, 120_000, 30_000)).rejects.toBe(failure);
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });
  it("releases the handle when serialization fails", async () => {
    const failure = new Error("context destroyed"), dispose = vi.fn(async () => {});
    const page = { waitForFunction: async () => ({ jsonValue: async () => { throw failure; }, dispose }) };
    await expect(waitForBookSnapshot(page, "last spread", settledBookSnapshot, 78, 120_000, 30_000)).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("bounds a stuck snapshot read and still releases its handle", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(async () => {});
    const page = { waitForFunction: async () => ({ jsonValue: () => new Promise(() => {}), dispose }) };
    const result = waitForBookSnapshot(page, "last spread", settledBookSnapshot, 78, 120_000, 30_000);
    const assertion = expect(result).rejects.toThrow("read captured snapshot: no answer within 30000 ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounded helper clears its watchdog on success", async () => {
    vi.useFakeTimers();
    expect(await bounded("probe", Promise.resolve(4), 30_000)).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("both production QA readers consume wait snapshots with no trailing DOM parse", () => {
    const source = readFileSync(new URL("./qa-journey-book-3d.mjs", import.meta.url), "utf8");
    const settle = source.slice(source.indexOf("  async function settledAt("), source.indexOf("  async function waitForBook("));
    const flying = source.slice(source.indexOf("  async function flightAt("), source.indexOf("  return { page, context"));
    expect(settle).toContain("settledBookSnapshot");
    expect(settle).toContain("deadline - performance.now()");
    expect(settle).toContain("page.waitForTimeout(1_200)");
    expect(settle.indexOf("page.waitForTimeout(1_200)")).toBeLessThan(settle.lastIndexOf("return snapshot()"));
    expect(flying).toContain("flightBookSnapshot");
    for (const part of [settle, flying]) {
      expect(part).not.toContain("page.evaluate");
      expect(part).not.toContain("JSON.parse");
    }
    expect(source).toContain("const SETTLE_TIMEOUT_MS = 120_000;");
    expect(source).toContain("const STEP_TIMEOUT_MS = 30_000;");
  });
});
