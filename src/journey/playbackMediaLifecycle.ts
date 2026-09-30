import { assign, createActor, fromPromise, setup, type SnapshotFrom } from "xstate";
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

export type PlaybackMediaLifecycleInput = {
  assetId: string;
  isImage: boolean;
};

export type PlaybackLifecycleRead = {
  url: string;
  preview?: MediaPreviewRead;
  issuedAt: number;
  expiresAt: number;
};

export type PlaybackMediaLifecycleContext = PlaybackMediaLifecycleInput & {
  requestedAt: number;
  read: PlaybackLifecycleRead | null;
  decoded: boolean;
  decodeError: string | null;
  error: string | null;
  intentRevision: number | null;
  suppressedIntents: number;
};

export type PlaybackMediaLifecycleEvent =
  | {
    type: "PREPARE";
    plannedRevision: number;
    liveRevision: number;
    blockedThroughRevision?: number | null;
  }
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

/**
 * One actor owns one Playback media intent. Leaving active aborts the invoked
 * read/decode work and XState discards any completion from that obsolete actor.
 * The director remains the transport authority; this machine only owns media IO.
 */
export const playbackMediaLifecycleMachine = setup({
  types: {
    context: {} as PlaybackMediaLifecycleContext,
    events: {} as PlaybackMediaLifecycleEvent,
    input: {} as PlaybackMediaLifecycleInput,
  },
  actors: {
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
                refreshing: {
                  entry: "markRequested",
                  invoke: {
                    src: "readMedia",
                    input: ({ context }) => ({ assetId: context.assetId }),
                    onDone: {
                      target: "fresh",
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

export function createPlaybackMediaLifecycleActor(
  input: PlaybackMediaLifecycleInput,
  reader: (assetId: string) => Promise<PrivateMediaRead>,
) {
  const machine = playbackMediaLifecycleMachine.provide({
    actors: {
      readMedia: fromPromise<PrivateMediaRead, { assetId: string }>(({ input: actorInput }) => reader(actorInput.assetId)),
    },
  });
  return createActor(machine, { input });
}

export type PlaybackMediaLifecycleActor = ReturnType<typeof createPlaybackMediaLifecycleActor>;

export type PlaybackMediaLifecycleSnapshot = SnapshotFrom<typeof playbackMediaLifecycleMachine>;

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
