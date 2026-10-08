import { describe, expect, it, vi } from "vitest";
import { requestRouteCandidates, requestRoutePointSuggestions } from "./journeyApi";
import {
  pollWhileRoutingPrepares,
  routingFailureMessage,
  routingPreparationCopy,
  type RoutingPreparing,
} from "./routingPreparation";

const preparing = (phase: RoutingPreparing["phase"], retryAfterMs: number): RoutingPreparing => ({ status: "preparing", phase, retryAfterMs });

describe("routing preparation polling", () => {
  it("re-issues the request with the clamped retry hint and reports each phase", async () => {
    const answers: unknown[] = [preparing("queued", 50), preparing("fetching", 60_000), preparing("building", 2_000), { suggestions: [] }];
    const waits: number[] = [];
    const phases: string[] = [];
    const result = await pollWhileRoutingPrepares(async () => answers.shift() as { suggestions: [] }, {
      signal: new AbortController().signal,
      onPreparing: (phase) => phases.push(phase),
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(result).toEqual({ suggestions: [] });
    expect(waits).toEqual([1_000, 5_000, 2_000]);
    expect(phases).toEqual(["queued", "fetching", "building"]);
  });

  it("gives up after four minutes with a specific error", async () => {
    let time = 0;
    const attempt = vi.fn(async () => preparing("building", 5_000));
    const error = await pollWhileRoutingPrepares(attempt, {
      signal: new AbortController().signal, now: () => time, sleep: async (ms) => { time += ms; },
    }).catch((reason) => reason);
    expect(error.code).toBe("ROUTING_PREPARING_TIMEOUT");
    expect(attempt).toHaveBeenCalledTimes(49);
    expect(routingFailureMessage(error)).toBe(error.message);
  });

  it("stops waiting as soon as the request is aborted", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => preparing("fetching", 5_000));
    const pending = pollWhileRoutingPrepares(attempt, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("names the phase and each graph failure instead of a generic failure", () => {
    expect(routingPreparationCopy("queued")).toBe("正在获取这段路线周边的道路…");
    expect(routingPreparationCopy("fetching")).toBe("正在获取这段路线周边的道路…");
    expect(routingPreparationCopy("building")).toBe("正在生成路网…");
    for (const code of ["ROUTING_DATA_UNAVAILABLE", "ROUTING_AREA_TOO_LARGE", "ROUTING_NO_ROADS", "ROUTING_GRAPH_BUILD_FAILED"]) {
      expect(routingFailureMessage({ code })).toBeTruthy();
    }
    expect(routingFailureMessage({ code: "ROUTE_SEGMENT_CHANGED" })).toBeNull();
    expect(routingFailureMessage(new Error("x"))).toBeNull();
  });
});

describe("road candidate requests while a graph is prepared", () => {
  it("polls the same candidate request through 202 and keeps the callback out of the body", async () => {
    vi.useFakeTimers();
    try {
      const bodies: unknown[] = [];
      const replies = [new Response(JSON.stringify(preparing("building", 1_000)), { status: 202 }),
        new Response(JSON.stringify({ sourceKey: "k", revision: 0, candidates: [] }))];
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return replies.shift()!; });
      const onPreparing = vi.fn();
      const pending = requestRouteCandidates("j", "a", "b", "k", 0, "walking", new AbortController().signal, fetcher, { allowFerries: true, onPreparing });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ sourceKey: "k", revision: 0, candidates: [] });
      expect(onPreparing).toHaveBeenCalledWith("building");
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual({ sourceKey: "k", revision: 0, profile: "walking", alternativesCount: 3, allowFerries: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the specific graph failure code from the error envelope", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "ROUTING_NO_ROADS", message: "No roads" }), { status: 422 }));
    const error = await requestRoutePointSuggestions({ coordinate: { lat: 0, lon: 0 }, neighbors: {}, profile: "cycling" },
      new AbortController().signal, fetcher).catch((reason) => reason);
    expect(error.code).toBe("ROUTING_NO_ROADS");
    expect(routingFailureMessage(error)).toContain("没有找到所选方式可通行的道路");
  });
});
