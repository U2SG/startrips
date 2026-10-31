import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_ROUTE_TIMEOUT_MS, routeCommand } from "./journeyApi";
import { commandBarFailure } from "./commandBarModel";

const context = { surface: "atlas" as const, intents: ["navigate" as const], activeJourneyId: null };
const answer = { intent: "unsupported", proposal: null };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("ordinary command request deadline", () => {
  it.each(["headers", "success body", "error body"])("terminates stalled %s and aborts transport", async stage => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => stage === "headers" ? new Promise(() => {})
      : Promise.resolve(new Response(new ReadableStream(), { status: stage === "error body" ? 502 : 200 })));
    const request = routeCommand("合成命令", context, undefined, fetcher);
    const failure = request.catch(error => error);
    await vi.advanceTimersByTimeAsync(COMMAND_ROUTE_TIMEOUT_MS);
    const error = await failure;
    expect(error).toMatchObject({ status: 504, code: "COMMAND_ROUTE_TIMEOUT" });
    expect(commandBarFailure(error).text).toContain("超时");
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("explicit cancellation settles even non-cooperative %s", async stage => {
    vi.useFakeTimers();
    const late = deferred<Response>();
    const body = deferred<unknown>();
    const response = Response.json(answer);
    vi.spyOn(response, "json").mockReturnValue(body.promise);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => stage === "headers" ? late.promise : Promise.resolve(response));
    const controller = new AbortController();
    const request = routeCommand("旧命令", context, controller.signal, fetcher);
    const failure = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); controller.abort(); await failure;
    late.resolve(Response.json(answer)); body.resolve(answer);
    await vi.advanceTimersByTimeAsync(COMMAND_ROUTE_TIMEOUT_MS);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(routeCommand("取消", context, controller.signal, fetcher)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("replacement succeeds while an aborted old request returns late", async () => {
    vi.useFakeTimers();
    const late = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(late.promise).mockResolvedValueOnce(Response.json(answer));
    const controller = new AbortController();
    const old = routeCommand("旧", context, controller.signal, fetcher);
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await expect(routeCommand("新", context, undefined, fetcher)).resolves.toEqual(answer);
    await rejected; late.resolve(Response.json({ intent: "navigate", proposal: { journeyId: "old" } }));
    await vi.advanceTimersByTimeAsync(COMMAND_ROUTE_TIMEOUT_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timeout stays terminal after a late successful response", async () => {
    vi.useFakeTimers(); const late = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(late.promise);
    const request = routeCommand("迟到", context, undefined, fetcher);
    const rejected = expect(request).rejects.toMatchObject({ code: "COMMAND_ROUTE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(COMMAND_ROUTE_TIMEOUT_MS); await rejected;
    late.resolve(Response.json(answer));
    await expect(request).rejects.toMatchObject({ code: "COMMAND_ROUTE_TIMEOUT" });
  });
});
