import { afterEach, describe, expect, it, vi } from "vitest";
import { observeScrollEdges, scrollEdges } from "./scrollEdges";

afterEach(() => vi.unstubAllGlobals());

describe("truthful scroll edges", () => {
  it("reports only content that remains beyond the viewport", () => {
    const metrics = { scrollHeight: 900, clientHeight: 300 };
    expect(scrollEdges({ ...metrics, scrollTop: 0 })).toEqual({ before: false, after: true });
    expect(scrollEdges({ ...metrics, scrollTop: 200 })).toEqual({ before: true, after: true });
    expect(scrollEdges({ ...metrics, scrollTop: 600 })).toEqual({ before: true, after: false });
  });
  it("handles elastic overscroll, fractional endpoints, empty and unknown layouts", () => {
    expect(scrollEdges({ scrollHeight: 900, clientHeight: 300, scrollTop: -50 })).toEqual({ before: false, after: true });
    expect(scrollEdges({ scrollHeight: 900, clientHeight: 300, scrollTop: 599.5 })).toEqual({ before: true, after: false });
    expect(scrollEdges({ scrollHeight: 900, clientHeight: 300, scrollTop: 950 })).toEqual({ before: true, after: false });
    for (const metrics of [
      { scrollHeight: 100, clientHeight: 300, scrollTop: 0 },
      { scrollHeight: 300.5, clientHeight: 300, scrollTop: 0 },
      { scrollHeight: 300, clientHeight: 0, scrollTop: 0 },
      { scrollHeight: NaN, clientHeight: 300, scrollTop: 0 },
    ]) expect(scrollEdges(metrics)).toEqual({ before: false, after: false });
  });
  it("batches input, observes content growth, avoids redundant writes and cancels late callbacks", () => {
    const attributes = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    let resizeCallback = () => {};
    let mutationCallback = () => {};
    const resizeObserve = vi.fn();
    const resizeDisconnect = vi.fn();
    const mutationDisconnect = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resizeCallback = callback; }
      observe = resizeObserve;
      disconnect = resizeDisconnect;
    });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { mutationCallback = callback; }
      observe() {}
      disconnect = mutationDisconnect;
    });
    const child = {};
    const element = {
      scrollTop: 0, scrollHeight: 900, clientHeight: 300, children: [child],
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
      removeAttribute: (name: string) => attributes.delete(name),
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); };
    const cleanup = observeScrollEdges(element as unknown as HTMLElement);
    expect(resizeObserve).toHaveBeenCalledWith(child);
    expect(frames.size).toBe(1);
    flush();
    expect(attributes.get("data-scroll-after")).toBe("true");
    const writes = element.setAttribute.mock.calls.length;
    listeners.get("scroll")!(); listeners.get("scroll")!(); resizeCallback();
    expect(frames.size).toBe(1);
    flush();
    expect(element.setAttribute.mock.calls.length).toBe(writes);
    element.scrollTop = 600;
    listeners.get("scroll")!(); flush();
    expect(attributes.get("data-scroll-before")).toBe("true");
    expect(attributes.get("data-scroll-after")).toBe("false");
    element.scrollHeight = 1500;
    mutationCallback(); flush();
    expect(attributes.get("data-scroll-after")).toBe("true");
    resizeCallback();
    cleanup();
    const observations = resizeObserve.mock.calls.length;
    resizeCallback(); mutationCallback(); flush();
    expect(frames.size).toBe(0);
    expect(attributes.size).toBe(0);
    expect(listeners.size).toBe(0);
    expect(resizeObserve.mock.calls.length).toBe(observations);
    expect(mutationDisconnect).toHaveBeenCalledOnce();
    expect(resizeDisconnect).toHaveBeenCalled();
  });
});
