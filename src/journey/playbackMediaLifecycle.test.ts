import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise } from "xstate";
import {
  playbackLifecycleDecodeReadiness,
  playbackLifecycleGate,
  playbackLifecycleHoldReason,
  playbackLifecycleMediaRead,
  playbackMediaLifecycleMachine,
} from "./playbackMediaLifecycle";
import type { PrivateMediaRead } from "./types";

const ISSUED = Date.parse("2026-09-24T00:00:00.000Z");
const OWNER_TTL_MS = 900_000;
const SHARE_TTL_MS = 90_000;
// A 90 s read is replaced one 30 s margin before it expires (mediaReadRefreshAt).
const SHARE_REFRESH_AFTER_MS = 60_000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signed(url: string, expiresAt: number): PrivateMediaRead {
  return { url, expiresAt: new Date(expiresAt).toISOString() };
}

type PendingRead = { assetId: string; signal: AbortSignal; request: Deferred<PrivateMediaRead> };
type PendingDecode = { url: string; signal: AbortSignal; request: Deferred<void> };

function startLifecycle(isImage: boolean) {
  const reads: PendingRead[] = [];
  const decodes: PendingDecode[] = [];
  const machine = playbackMediaLifecycleMachine.provide({
    actors: {
      readMedia: fromPromise<PrivateMediaRead, { assetId: string }>(({ input, signal }) => {
        const request = deferred<PrivateMediaRead>();
        reads.push({ assetId: input.assetId, signal, request });
        return request.promise;
      }),
      decodeImage: fromPromise<void, { url: string }>(({ input, signal }) => {
        const request = deferred<void>();
        decodes.push({ url: input.url, signal, request });
        return request.promise;
      }),
    },
  });
  const actor = createActor(machine, {
    input: { assetId: isImage ? "asset-image" : "asset-video", isImage },
  });
  actor.start();
  return { actor, reads, decodes };
}

/** The director's live intent: planned against the revision that is still current. */
function prepare(revision: number) {
  return { type: "PREPARE" as const, plannedRevision: revision, liveRevision: revision };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

const imageAsset = {
  id: "asset-image",
  journeyId: "journey",
  routePointId: "point",
  storageDriver: "qa",
  storageKey: "qa/image",
  fileName: "image.png",
  mimeType: "image/png",
  bytes: 68,
  sortOrder: 0,
  uploadedByUserId: "user",
  createdAt: "2026-09-05T00:00:00.000Z",
};
const videoAsset = { ...imageAsset, id: "asset-video", fileName: "clip.mp4", mimeType: "video/mp4" };

beforeEach(() => {
  vi.useFakeTimers({ now: ISSUED });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stale prefetch intent (#287)", () => {
  it("never starts a read for an intent planned against a superseded revision", () => {
    const { actor, reads } = startLifecycle(true);
    actor.send({ type: "PREPARE", plannedRevision: 1, liveRevision: 2 });
    // Quick Recap blocks through the tempo revision until the rebuilt plan commits.
    actor.send({ type: "PREPARE", plannedRevision: 3, liveRevision: 3, blockedThroughRevision: 3 });
    expect(reads).toHaveLength(0);
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.suppressedIntents).toBe(2);
  });

  it("aborts a read whose intent was superseded and ignores its late answer", async () => {
    const { actor, reads } = startLifecycle(false);
    actor.send(prepare(1));
    actor.send({ type: "RELEASE" });
    expect(reads[0].signal.aborted).toBe(true);

    actor.send(prepare(2));
    reads[1].request.resolve(signed("signed-b", ISSUED + OWNER_TTL_MS));
    await settle();
    // The superseded request answers last; it must not replace the live read.
    reads[0].request.resolve(signed("signed-a", ISSUED + OWNER_TTL_MS));
    await settle();

    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({
      status: "ready",
      url: "signed-b",
    });
    expect(actor.getSnapshot().context.intentRevision).toBe(2);
  });

  it("leaves a released asset idle when its superseded read resolves", async () => {
    const { actor, reads } = startLifecycle(true);
    actor.send(prepare(1));
    actor.send({ type: "RELEASE" });
    reads[0].request.resolve(signed("signed-a", ISSUED + OWNER_TTL_MS));
    await settle();
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.read).toBeNull();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toBeUndefined();
  });

  it("keeps one read in flight while newer intents keep the asset in the window", () => {
    const { actor, reads } = startLifecycle(true);
    actor.send(prepare(1));
    actor.send(prepare(2));
    actor.send({ type: "PREPARE", plannedRevision: 1, liveRevision: 3 });
    expect(reads).toHaveLength(1);
    expect(actor.getSnapshot().context.intentRevision).toBe(2);
    expect(actor.getSnapshot().context.suppressedIntents).toBe(1);
  });
});

describe("signed URL expiring mid-read (#200 phase D)", () => {
  it("re-signs a short share read that was already stale when it arrived", async () => {
    const { actor, reads } = startLifecycle(false);
    actor.send(prepare(1));
    // The server signed a 15 s read at request time, but the answer took 10 s.
    await vi.advanceTimersByTimeAsync(10_000);
    reads[0].request.resolve(signed("signed-1", ISSUED + 15_000));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({
      url: "signed-1",
      issuedAt: ISSUED,
    });

    // Past its half-life, so the refresh fires at the 1 s timer floor.
    await vi.advanceTimersByTimeAsync(999);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(2);
    // The previous URL is still inside its lifetime, so the beat is not reset.
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");

    reads[1].request.resolve(signed("signed-2", ISSUED + 26_000));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({
      url: "signed-2",
      issuedAt: ISSUED + 11_000,
    });
  });

  it("refreshes a URL that goes stale during decode without restarting the decode", async () => {
    const { actor, reads, decodes } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + SHARE_TTL_MS));
    await settle();
    expect(decodes).toHaveLength(1);
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("waiting");

    await vi.advanceTimersByTimeAsync(SHARE_REFRESH_AFTER_MS);
    expect(reads).toHaveLength(2);
    expect(decodes[0].signal.aborted).toBe(false);

    reads[1].request.resolve(signed("signed-2", ISSUED + SHARE_TTL_MS * 1.5));
    decodes[0].request.resolve();
    await settle();
    expect(decodes).toHaveLength(1);
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toMatchObject({ url: "signed-2" });
  });

  it("does not keep re-signing an asset whose intent was released", async () => {
    const { actor, reads } = startLifecycle(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + SHARE_TTL_MS));
    await settle();
    actor.send({ type: "RELEASE" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads).toHaveLength(1);
  });
});

describe("close during decode (77e9e28)", () => {
  it("aborts the decode on release and ignores its late settle", async () => {
    const { actor, reads, decodes } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + OWNER_TTL_MS));
    await settle();
    actor.send({ type: "RELEASE" });
    expect(decodes[0].signal.aborted).toBe(true);

    decodes[0].request.resolve();
    await settle();
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.decoded).toBe(false);
    expect(playbackLifecycleDecodeReadiness(actor.getSnapshot())).toBeUndefined();
  });

  it("aborts every pending actor when Playback closes the lifecycle", async () => {
    const { actor, reads, decodes } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + SHARE_TTL_MS));
    await settle();
    await vi.advanceTimersByTimeAsync(SHARE_REFRESH_AFTER_MS);
    expect(reads).toHaveLength(2);

    actor.stop();
    expect(decodes[0].signal.aborted).toBe(true);
    expect(reads[1].signal.aborted).toBe(true);
    expect(actor.getSnapshot().status).toBe("stopped");
  });
});

describe("reopen the same media (#276, #284)", () => {
  it("reuses a read that is still fresh instead of re-signing or re-decoding it", async () => {
    const { actor, reads, decodes } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + OWNER_TTL_MS));
    await settle();
    decodes[0].request.resolve();
    await settle();
    actor.send({ type: "RELEASE" });

    await vi.advanceTimersByTimeAsync(10_000);
    actor.send(prepare(2));
    expect(reads).toHaveLength(1);
    expect(decodes).toHaveLength(1);
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
  });

  it("re-signs a read that the pause outlived", async () => {
    const { actor, reads } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + SHARE_TTL_MS));
    await settle();
    actor.send({ type: "RELEASE" });

    await vi.advanceTimersByTimeAsync(SHARE_REFRESH_AFTER_MS + 1_000);
    actor.send(prepare(2));
    expect(reads).toHaveLength(2);
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({ status: "loading" });
  });

  it("gives a deliberate revisit its own attempt after a failure", async () => {
    const { actor, reads } = startLifecycle(false);
    actor.send(prepare(1));
    reads[0].request.reject(new Error("network down"));
    await settle();
    expect(actor.getSnapshot().value).toBe("failed");

    actor.send({ type: "RELEASE" });
    actor.send(prepare(2));
    expect(reads).toHaveLength(2);
    // A revisit without leaving first is also a new attempt.
    reads[1].request.reject(new Error("network down"));
    await settle();
    actor.send(prepare(3));
    expect(reads).toHaveLength(3);
    reads[2].request.resolve(signed("signed-3", ISSUED + OWNER_TTL_MS));
    await settle();
    expect(playbackLifecycleGate(actor.getSnapshot())).toBe("ready");
  });
});

describe("read failure is truthful", () => {
  it("keeps the server's message and settles the gate as an error", async () => {
    const { actor, reads } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.reject(new Error("share grant expired"));
    await settle();
    const snapshot = actor.getSnapshot();
    expect(playbackLifecycleMediaRead(snapshot)).toEqual({
      status: "error",
      message: "share grant expired",
    });
    expect(playbackLifecycleGate(snapshot)).toBe("error");
    // A settled failure releases the beat so the step renders its error state.
    expect(playbackLifecycleHoldReason(snapshot, {
      stepKind: "media",
      asset: imageAsset,
      videoPlaybackFailed: false,
      trimStatus: null,
    })).toBe("none");
  });

  it("falls back to the overlay's copy when the rejection carries no message", async () => {
    const { actor, reads } = startLifecycle(false);
    actor.send(prepare(1));
    reads[0].request.reject("offline");
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({
      status: "error",
      message: "媒体读取失败",
    });
  });

  it("fails a refresh truthfully instead of keeping a URL about to expire", async () => {
    const { actor, reads } = startLifecycle(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + SHARE_TTL_MS));
    await settle();
    await vi.advanceTimersByTimeAsync(SHARE_REFRESH_AFTER_MS);
    reads[1].request.reject(new Error("share revoked"));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({
      status: "error",
      message: "share revoked",
    });
  });

  it("reports a decode failure through the decode readiness, not as a read failure", async () => {
    const { actor, reads, decodes } = startLifecycle(true);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-1", ISSUED + OWNER_TTL_MS));
    await settle();
    decodes[0].request.reject(new Error("corrupt image"));
    await settle();
    const snapshot = actor.getSnapshot();
    expect(playbackLifecycleMediaRead(snapshot)).toMatchObject({ status: "ready" });
    expect(playbackLifecycleDecodeReadiness(snapshot)).toEqual({
      status: "error",
      message: "corrupt image",
    });
    expect(playbackLifecycleGate(snapshot)).toBe("error");
  });

  it("refuses to invent a read when no read actor was provided", async () => {
    const actor = createActor(playbackMediaLifecycleMachine, {
      input: { assetId: "asset-video", isImage: false },
    });
    actor.start();
    actor.send(prepare(1));
    await settle();
    expect(playbackLifecycleMediaRead(actor.getSnapshot())).toEqual({
      status: "error",
      message: "readMedia actor was not provided",
    });
    actor.stop();
  });
});

describe("hold gating reuses playbackHoldReason (#197)", () => {
  it("holds an image beat until its read is signed and decoded", async () => {
    const { actor, reads, decodes } = startLifecycle(true);
    const beat = {
      stepKind: "media" as const,
      asset: imageAsset,
      videoPlaybackFailed: false,
      trimStatus: null,
    };
    actor.send(prepare(1));
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), beat)).toBe("decode");
    reads[0].request.resolve(signed("signed-1", ISSUED + OWNER_TTL_MS));
    await settle();
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), beat)).toBe("decode");
    // The arrival beat waits on the same first image.
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), { ...beat, stepKind: "stop" }))
      .toBe("decode");
    decodes[0].request.resolve();
    await settle();
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), beat)).toBe("none");
  });

  it("hands a ready video beat to the element, or to its trim while positioning", async () => {
    const { actor, reads, decodes } = startLifecycle(false);
    actor.send(prepare(1));
    reads[0].request.resolve(signed("signed-video", ISSUED + OWNER_TTL_MS));
    await settle();
    expect(decodes).toHaveLength(0);
    const beat = {
      stepKind: "media" as const,
      asset: videoAsset,
      videoPlaybackFailed: false,
      trimStatus: null,
    };
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), beat)).toBe("video");
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), { ...beat, trimStatus: "positioning" }))
      .toBe("trim");
    expect(playbackLifecycleHoldReason(actor.getSnapshot(), { ...beat, videoPlaybackFailed: true }))
      .toBe("none");
  });
});
