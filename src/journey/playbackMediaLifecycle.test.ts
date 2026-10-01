import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise } from "xstate";
import {
  playbackLifecycleDecodeReadiness,
  playbackLifecycleGate,
  playbackLifecycleMediaRead,
  playbackMediaLifecycleMachine,
  stopPlaybackMediaLifecycleActorsForJourney,
} from "./playbackMediaLifecycle";
import type { PrivateMediaRead } from "./types";
import type { MediaReadState } from "./mediaReadRefresh";

const NOW = Date.parse("2026-09-30T00:00:00.000Z");

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function signed(
  url: string,
  ttlMs = 90_000,
  preview?: PrivateMediaRead["preview"],
): PrivateMediaRead {
  return {
    url,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    ...(preview ? { preview } : {}),
  };
}

function start(isImage = true, initialRead?: MediaReadState) {
  const reads: Array<{ signal: AbortSignal; request: Deferred<PrivateMediaRead> }> = [];
  const decodes: Array<{ signal: AbortSignal; url: string; request: Deferred<void> }> = [];
  const machine = playbackMediaLifecycleMachine.provide({
    actors: {
      readMedia: fromPromise<PrivateMediaRead, { assetId: string }>(({ signal }) => {
        const request = deferred<PrivateMediaRead>();
        reads.push({ signal, request });
        return request.promise;
      }),
      decodeImage: fromPromise<void, { url: string }>(({ signal, input }) => {
        const request = deferred<void>();
        decodes.push({ signal, url: input.url, request });
        return request.promise;
      }),
    },
  });
  const actor = createActor(machine, { input: { assetId: "asset", isImage, initialRead } });
  actor.start();
  return { actor, reads, decodes };
}

function prepare(revision: number) {
  return { type: "PREPARE" as const, plannedRevision: revision, liveRevision: revision };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

describe("playbackMediaLifecycle", () => {
  it("stops only actors owned by the journey being released", () => {
    const stopped: string[] = [];
    const actors = new Map([
      ["journey-a:asset-1", { stop: () => stopped.push("a-1") }],
      ["journey-b:asset-1", { stop: () => stopped.push("b-1") }],
      ["journey-a:asset-2", { stop: () => stopped.push("a-2") }],
    ]);

    stopPlaybackMediaLifecycleActorsForJourney(actors, "journey-a");

    expect(stopped).toEqual(["a-1", "a-2"]);
    expect([...actors.keys()]).toEqual(["journey-b:asset-1"]);
  });

  it("suppresses stale intents before read dispatch", () => {
    const { actor, reads } = start();
    actor.send({ type: "PREPARE", plannedRevision: 1, liveRevision: 2 });
    actor.send({ type: "PREPARE", plannedRevision: 3, liveRevision: 3, blockedThroughRevision: 3 });
    expect(reads).toHaveLength(0);
    expect(actor.getSnapshot().context.suppressedIntents).toBe(2);
    actor.stop();
  });

  it("aborts a released read and ignores its late answer", async () => {
    const { actor, reads } = start(false);
    actor.send(prepare(1));
    actor.send({ type: "RELEASE" });
    expect(reads[0].signal.aborted).toBe(true);
    actor.send(prepare(2));
    reads[1].request.resolve(signed("fresh"));
    await settle();
    reads[0].request.resolve(signed("obsolete"));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "fresh" });
    actor.stop();
  });

  it("refreshes an expiring read without blanking the presentable frame", async () => {
    const { actor, reads } = start(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("first", 90_000));
    await settle();
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(2);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "first" });
    reads[1].request.resolve(signed("second", 90_000));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "second" });
    actor.stop();
  });

  it("re-decodes a refreshed image URL without blanking the presentable frame", async () => {
    const { actor, reads, decodes } = start(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("image-1", 90_000));
    await settle();
    expect(decodes).toHaveLength(1);
    expect(decodes[0].url).toBe("image-1");
    decodes[0].request.resolve();
    await settle();
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(2);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "image-1" });
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");

    reads[1].request.resolve(signed("image-2", 90_000));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "image-2" });
    expect(decodes).toHaveLength(2);
    expect(decodes[1].url).toBe("image-2");
    expect(playbackLifecycleDecodeReadiness(actor.getSnapshot())).toEqual({ status: "pending" });
    expect(playbackLifecycleGate(actor.getSnapshot())).not.toBe("ready");

    decodes[1].request.resolve();
    await settle();
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
    actor.stop();
  });

  it("aborts decode when the intent leaves", async () => {
    const { actor, reads, decodes } = start(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("image"));
    await settle();
    expect(decodes).toHaveLength(1);
    actor.send({ type: "RELEASE" });
    expect(decodes[0].signal.aborted).toBe(true);
    decodes[0].request.resolve();
    await settle();
    expect(playbackLifecycleDecodeReadiness(actor.getSnapshot())).toBeUndefined();
    actor.stop();
  });

  it("warms same-asset previews for image and video prefetch actors", async () => {
    const preview = {
      url: "preview",
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    };

    const image = start(true);
    image.actor.send(prepare(1));
    image.reads[0].request.resolve(signed("image-original", 900_000, preview));
    await settle();
    expect(image.decodes.map(({ url }) => url).sort()).toEqual(["image-original", "preview"].sort());
    expect(playbackLifecycleGate(image.actor.getSnapshot())).not.toBe("ready");
    image.decodes.find(({ url }) => url === "image-original")!.request.resolve();
    await settle();
    expect(playbackLifecycleGate(image.actor.getSnapshot())).toBe("ready");
    image.actor.stop();

    const video = start(false);
    video.actor.send(prepare(1));
    video.reads[0].request.resolve(signed("video-original", 900_000, preview));
    await settle();
    expect(video.decodes.map(({ url }) => url)).toEqual(["preview"]);
    expect(playbackLifecycleGate(video.actor.getSnapshot())).toBe("ready");
    video.actor.stop();
  });

  it("invalidates obsolete preview warming with the owning intent", async () => {
    const preview = {
      url: "preview",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    };
    const { actor, reads, decodes } = start(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("video-original", 900_000, preview));
    await settle();
    expect(decodes).toHaveLength(1);
    expect(decodes[0].url).toBe("preview");

    actor.send({ type: "RELEASE" });
    expect(decodes[0].signal.aborted).toBe(true);
    decodes[0].request.resolve();
    await settle();

    actor.send(prepare(2));
    await settle();
    expect(reads).toHaveLength(1);
    expect(decodes).toHaveLength(2);
    expect(decodes[1].url).toBe("preview");
    actor.stop();
  });

  it("re-warms a refreshed preview without blanking the current read", async () => {
    const firstPreview = {
      url: "preview-1",
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    };
    const secondPreview = { ...firstPreview, url: "preview-2" };
    const { actor, reads, decodes } = start(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("video-1", 90_000, firstPreview));
    await settle();
    expect(decodes.map(({ url }) => url)).toEqual(["preview-1"]);
    decodes[0].request.resolve();
    await settle();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(2);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "video-1" });
    reads[1].request.resolve(signed("video-2", 90_000, secondPreview));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ status: "ready", url: "video-2" });
    expect(decodes.map(({ url }) => url)).toEqual(["preview-1", "preview-2"]);
    actor.stop();
  });

  it("seeds a replacement actor from a still-fresh read after overlay close", () => {
    const initialRead: MediaReadState = {
      status: "ready",
      url: "cached-video",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 900_000,
    };
    const { actor, reads } = start(false, initialRead);
    actor.send(prepare(1));
    expect(reads).toHaveLength(0);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual(initialRead);
    actor.stop();
  });

  it("re-signs instead of reusing an expired read seeded into a replacement actor", () => {
    const initialRead: MediaReadState = {
      status: "ready",
      url: "expired-video",
      issuedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1,
    };
    const { actor, reads } = start(false, initialRead);
    actor.send(prepare(1));
    expect(reads).toHaveLength(1);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({ status: "loading" });
    actor.stop();
  });

  it("reuses a fresh read and decoded image after deliberate reopen", async () => {
    const { actor, reads, decodes } = start(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("image", 900_000));
    await settle();
    decodes[0].request.resolve();
    await settle();
    actor.send({ type: "RELEASE" });
    await vi.advanceTimersByTimeAsync(10_000);
    actor.send(prepare(2));
    expect(reads).toHaveLength(1);
    expect(decodes).toHaveLength(1);
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
    actor.stop();
  });

  it("re-signs an expired reopen instead of reusing stale authority", async () => {
    const { actor, reads } = start(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("short", 20_000));
    await settle();
    actor.send({ type: "RELEASE" });
    await vi.advanceTimersByTimeAsync(11_000);
    actor.send(prepare(2));
    expect(reads).toHaveLength(2);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({ status: "loading" });
    actor.stop();
  });

  it("re-decodes the new signed URL after an expired image reopen", async () => {
    const { actor, reads, decodes } = start(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("image-short", 20_000));
    await settle();
    expect(decodes[0].url).toBe("image-short");
    decodes[0].request.resolve();
    await settle();
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");

    actor.send({ type: "RELEASE" });
    await vi.advanceTimersByTimeAsync(11_000);
    actor.send(prepare(2));
    expect(reads).toHaveLength(2);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({ status: "loading" });

    reads[1].request.resolve(signed("image-fresh", 90_000));
    await settle();
    expect(decodes).toHaveLength(2);
    expect(decodes[1].url).toBe("image-fresh");
    expect(playbackLifecycleDecodeReadiness(actor.getSnapshot())).toEqual({ status: "pending" });
    expect(playbackLifecycleGate(actor.getSnapshot())).not.toBe("ready");
    decodes[1].request.resolve();
    await settle();
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
    actor.stop();
  });

  it("reports read and decode failures truthfully", async () => {
    const readFailure = start(false);
    readFailure.actor.send(prepare(1));
    readFailure.reads[0].request.reject(new Error("grant expired"));
    await settle();
    expect(playbackLifecycleMediaRead(readFailure.actor.getSnapshot())).toEqual({
      status: "error",
      message: "grant expired",
    });
    readFailure.actor.stop();

    const decodeFailure = start(true);
    decodeFailure.actor.send(prepare(1));
    decodeFailure.reads[0].request.resolve(signed("bad-image", 900_000));
    await settle();
    decodeFailure.decodes[0].request.reject(new Error("decode failed"));
    await settle();
    expect(playbackLifecycleDecodeReadiness(decodeFailure.actor.getSnapshot())).toEqual({
      status: "error",
      message: "decode failed",
    });
    expect(playbackLifecycleGate(decodeFailure.actor.getSnapshot())).toBe("error");
    decodeFailure.actor.stop();
  });

  it("stops every owned async actor on Playback close", async () => {
    const { actor, reads, decodes } = start(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("image"));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    actor.stop();
    expect(decodes[0].signal.aborted).toBe(true);
    expect(reads[1].signal.aborted).toBe(true);
  });
});
