import { assign, fromPromise, setup, type SnapshotFrom } from "xstate";
import { decodeImageUrl, type DecodedReadiness } from "./mediaPrefetch";
import {
  mediaReadRefreshDelayMs,
  playbackReadIsReusable,
  type MediaReadState,
} from "./mediaReadRefresh";
import {
  playbackHoldReason,
  playbackMediaGate,
  type PlaybackHoldReason,
  type PlaybackMediaGate,
} from "./playbackMediaPresentation";
import { prefetchDispatchDecision } from "./playbackPrefetchPlan";
import type { JourneyMediaAsset, MediaPreviewRead, PrivateMediaRead } from "./types";

// SPIKE (discussion #539 section 6) — not wired into Playback.
//
// One actor per Route Point Media asset that Playback intends to show. The
// overlay spreads this lifecycle over a read map, a pending-read set, a decode
// registry with a settle revision and several effects; here it is one machine
// whose invoked actors are stopped, and their signals aborted, the moment the
// state that owns them is left. A superseded intent therefore cannot land a late
// result: the actor that would have delivered it no longer exists.
//
// The rules are not restated here. Freshness and refresh timing come from
// `mediaReadRefresh`, the stale-intent boundary from `prefetchDispatchDecision`,
// and the gate and hold answers from `playbackMediaPresentation`.

export type PlaybackMediaLifecycleInput = {
  assetId: string;
  /** Images must also decode before they gate as ready; videos gate on the read. */
  isImage: boolean;
};

/** A signed read as the lifecycle holds it: the lifetime is measured from the request. */
export type PlaybackLifecycleRead = {
  url: string;
  preview?: MediaPreviewRead;
  issuedAt: number;
  expiresAt: number;
};

export type PlaybackMediaLifecycleContext = PlaybackMediaLifecycleInput & {
  /** When the in-flight read was requested; it becomes the read's `issuedAt`. */
  requestedAt: number;
  read: PlaybackLifecycleRead | null;
  decoded: boolean;
  decodeError: string | null;
  error: string | null;
  /** The director intent revision that last prepared this asset. */
  intentRevision: number | null;
  /** Prepare requests refused because their planned revision was already stale. */
  suppressedIntents: number;
};

export type PlaybackMediaLifecycleEvent =
  | {
    /** The prefetch window or the current beat wants this asset. */
    type: "PREPARE";
    plannedRevision: number;
    liveRevision: number;
    blockedThroughRevision?: number | null;
  }
  /** The intent left: the window moved past this asset, or Playback closed it. */
  | { type: "RELEASE" };

const READ_FAILED_MESSAGE = "媒体读取失败";
const DECODE_FAILED_MESSAGE = "图片解码失败";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function lifecycleRead(
  requestedAt: number,
  read: Pick<PrivateMediaRead, "url" | "expiresAt" | "preview">,
): PlaybackLifecycleRead {
  return {
    url: read.url,
    preview: read.preview,
    issuedAt: requestedAt,
    expiresAt: Date.parse(read.expiresAt),
  };
}

function readState(read: PlaybackLifecycleRead | null): MediaReadState | undefined {
  return read ? { status: "ready", ...read } : undefined;
}

export const playbackMediaLifecycleMachine = setup({
  types: {
    context: {} as PlaybackMediaLifecycleContext,
    events: {} as PlaybackMediaLifecycleEvent,
    input: {} as PlaybackMediaLifecycleInput,
  },
  actors: {
    // Production would provide `useAtlasView().readMedia`; the default refuses
    // loudly instead of inventing a URL, so an unprovided machine fails truthfully.
    readMedia: fromPromise<PrivateMediaRead, { assetId: string }>(async () => {
      throw new Error("readMedia actor was not provided");
    }),
    decodeImage: fromPromise<void, { url: string }>(({ input }) => decodeImageUrl(input.url)),
  },
  guards: {
    intentIsStale: ({ event }) => event.type === "PREPARE"
      && prefetchDispatchDecision(event) === "suppress-stale",
    readIsReusable: ({ context }) => playbackReadIsReusable(readState(context.read), Date.now()),
    decodeNotNeeded: ({ context }) => !context.isImage,
    alreadyDecoded: ({ context }) => context.decoded,
  },
  delays: {
    refreshDelay: ({ context }) => (context.read
      ? mediaReadRefreshDelayMs(context.read.issuedAt, context.read.expiresAt, Date.now())
      : 1_000),
  },
  actions: {
    recordIntent: assign({
      intentRevision: ({ event }) => (event.type === "PREPARE" ? event.plannedRevision : null),
    }),
    countSuppressed: assign({
      suppressedIntents: ({ context }) => context.suppressedIntents + 1,
    }),
    markRequested: assign({ requestedAt: () => Date.now() }),
  },
}).createMachine({
  id: "playbackMediaLifecycle",
  context: ({ input }) => ({
    ...input,
    requestedAt: 0,
    read: null,
    decoded: false,
    decodeError: null,
    error: null,
    intentRevision: null,
    suppressedIntents: 0,
  }),
  initial: "idle",
  states: {
    idle: {
      on: {
        PREPARE: [
          { guard: "intentIsStale", actions: "countSuppressed" },
          { guard: "readIsReusable", target: "active.ready", actions: "recordIntent" },
          { target: "active.reading", actions: "recordIntent" },
        ],
      },
    },
    active: {
      on: {
        RELEASE: { target: "idle" },
        // Already prepared: a newer intent only moves the revision. A stale one
        // is counted and dropped, so it can never restart work.
        PREPARE: [
          { guard: "intentIsStale", actions: "countSuppressed" },
          { actions: "recordIntent" },
        ],
      },
      initial: "reading",
      states: {
        reading: {
          entry: "markRequested",
          invoke: {
            src: "readMedia",
            input: ({ context }) => ({ assetId: context.assetId }),
            onDone: {
              target: "ready",
              actions: assign({
                read: ({ context, event }) => lifecycleRead(context.requestedAt, event.output),
                error: null,
              }),
            },
            onError: {
              target: "#playbackMediaLifecycle.failed",
              actions: assign({
                error: ({ event }) => errorMessage(event.error, READ_FAILED_MESSAGE),
              }),
            },
          },
        },
        ready: {
          type: "parallel",
          states: {
            signedUrl: {
              initial: "fresh",
              states: {
                fresh: {
                  after: { refreshDelay: { target: "refreshing" } },
                },
                // The previous URL stays in context while the replacement is
                // signed: refresh happens before expiry, so it is still valid.
                refreshing: {
                  entry: "markRequested",
                  invoke: {
                    src: "readMedia",
                    input: ({ context }) => ({ assetId: context.assetId }),
                    onDone: {
                      target: "fresh",
                      actions: assign({
                        read: ({ context, event }) => lifecycleRead(context.requestedAt, event.output),
                      }),
                    },
                    onError: {
                      target: "#playbackMediaLifecycle.failed",
                      actions: assign({
                        error: ({ event }) => errorMessage(event.error, READ_FAILED_MESSAGE),
                      }),
                    },
                  },
                },
              },
            },
            decode: {
              initial: "checking",
              states: {
                checking: {
                  always: [
                    { guard: "decodeNotNeeded", target: "notNeeded" },
                    { guard: "alreadyDecoded", target: "decoded" },
                    { target: "decoding" },
                  ],
                },
                decoding: {
                  invoke: {
                    src: "decodeImage",
                    input: ({ context }) => ({ url: context.read!.url }),
                    onDone: {
                      target: "decoded",
                      actions: assign({ decoded: true, decodeError: null }),
                    },
                    onError: {
                      target: "failed",
                      actions: assign({
                        decodeError: ({ event }) => errorMessage(event.error, DECODE_FAILED_MESSAGE),
                      }),
                    },
                  },
                },
                decoded: {},
                notNeeded: {},
                failed: {},
              },
            },
          },
        },
      },
    },
    // Terminal for this intent, but never sticky: a deliberate revisit is a new
    // attempt, as the overlay's per-step fallback reset already promises.
    failed: {
      entry: assign({ read: null, decoded: false, decodeError: null }),
      on: {
        RELEASE: { target: "idle" },
        PREPARE: [
          { guard: "intentIsStale", actions: "countSuppressed" },
          { target: "active.reading", actions: "recordIntent" },
        ],
      },
    },
  },
});

export type PlaybackMediaLifecycleSnapshot = SnapshotFrom<typeof playbackMediaLifecycleMachine>;

/** The lifecycle as the `MediaReadState` the existing presentation rules consume. */
export function playbackLifecycleMediaRead(
  snapshot: PlaybackMediaLifecycleSnapshot,
): MediaReadState | undefined {
  if (snapshot.matches("failed")) {
    return { status: "error", message: snapshot.context.error ?? READ_FAILED_MESSAGE };
  }
  if (snapshot.matches({ active: "reading" })) return { status: "loading" };
  if (snapshot.matches({ active: "ready" })) return readState(snapshot.context.read);
  return undefined;
}

/** The lifecycle as the decode registry's `DecodedReadiness`, for images only. */
export function playbackLifecycleDecodeReadiness(
  snapshot: PlaybackMediaLifecycleSnapshot,
): DecodedReadiness | undefined {
  if (!snapshot.context.isImage) return undefined;
  if (snapshot.matches({ active: { ready: { decode: "decoded" } } })) return { status: "decoded" };
  if (snapshot.matches({ active: { ready: { decode: "failed" } } })) {
    return { status: "error", message: snapshot.context.decodeError ?? DECODE_FAILED_MESSAGE };
  }
  if (snapshot.matches({ active: "ready" })) return { status: "pending" };
  return undefined;
}

export function playbackLifecycleGate(snapshot: PlaybackMediaLifecycleSnapshot): PlaybackMediaGate {
  return playbackMediaGate(
    playbackLifecycleMediaRead(snapshot),
    playbackLifecycleDecodeReadiness(snapshot),
    snapshot.context.isImage,
  );
}

export function playbackLifecycleHoldReason(
  snapshot: PlaybackMediaLifecycleSnapshot,
  beat: {
    stepKind: Parameters<typeof playbackHoldReason>[0]["stepKind"];
    asset: JourneyMediaAsset | null;
    videoPlaybackFailed: boolean;
    trimStatus: Parameters<typeof playbackHoldReason>[0]["trimStatus"];
  },
): PlaybackHoldReason {
  return playbackHoldReason({ ...beat, gate: playbackLifecycleGate(snapshot) });
}
