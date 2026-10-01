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
  initialRead?: MediaReadState;
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
  previewRequestedUrl: string | null;
  previewWarmedUrl: string | null;
  decodeRequestedUrl: string | null;
  decodedUrl: string | null;
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

function initialLifecycleRead(read: MediaReadState | undefined): PlaybackLifecycleRead | null {
  if (read?.status !== "ready") return null;
  return {
    url: read.url,
    preview: read.preview,
    issuedAt: read.issuedAt,
    expiresAt: read.expiresAt,
  };
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
    previewNotNeeded: ({ context }) => !context.read?.preview,
    previewWarmSatisfied: ({ context }) => context.read?.preview?.url === context.previewWarmedUrl,
    previewWarmChanged: ({ context }) => (context.read?.preview?.url ?? null) !== context.previewWarmedUrl,
    previewWarmNeeded: ({ context }) => Boolean(
      context.read?.preview && context.read.preview.url !== context.previewWarmedUrl
    ),
    previewRequestChanged: ({ context }) => (
      (context.read?.preview?.url ?? null) !== context.previewRequestedUrl
    ),
    decodeRequestChanged: ({ context }) => (context.read?.url ?? null) !== context.decodeRequestedUrl,
    alreadyDecoded: ({ context }) => Boolean(
      context.read?.url && context.read.url === context.decodedUrl
    ),
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
    markPreviewRequested: assign({
      previewRequestedUrl: ({ context }) => context.read?.preview?.url ?? null,
    }),
    markPreviewWarmed: assign({
      previewWarmedUrl: ({ context }) => context.previewRequestedUrl,
    }),
    markDecodeRequested: assign({
      decodeRequestedUrl: ({ context }) => context.read?.url ?? null,
    }),
    markDecoded: assign({
      decodedUrl: ({ context }) => context.decodeRequestedUrl,
      decodeError: null,
    }),
  },
}).createMachine({
  id: "playbackMediaLifecycle",
  context: ({ input }) => ({
    assetId: input.assetId,
    isImage: input.isImage,
    initialRead: input.initialRead,
    requestedAt: 0,
    read: initialLifecycleRead(input.initialRead),
    previewRequestedUrl: null,
    previewWarmedUrl: null,
    decodeRequestedUrl: null,
    decodedUrl: null,
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
            previewWarm: {
              initial: "checking",
              states: {
                checking: {
                  always: [
                    { guard: "previewNotNeeded", target: "notNeeded" },
                    { guard: "previewWarmSatisfied", target: "warmed" },
                    { target: "warming" },
                  ],
                },
                warming: {
                  entry: "markPreviewRequested",
                  always: { guard: "previewRequestChanged", target: "checking" },
                  invoke: {
                    src: "decodeImage",
                    input: ({ context }) => ({ url: context.read!.preview!.url }),
                    onDone: { target: "warmed", actions: "markPreviewWarmed" },
                    onError: { target: "failed" },
                  },
                },
                warmed: {
                  always: { guard: "previewWarmChanged", target: "checking" },
                },
                notNeeded: {
                  always: { guard: "previewWarmNeeded", target: "checking" },
                },
                failed: {
                  always: { guard: "previewRequestChanged", target: "checking" },
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
                  entry: "markDecodeRequested",
                  always: { guard: "decodeRequestChanged", target: "checking" },
                  invoke: {
                    src: "decodeImage",
                    input: ({ context }) => ({ url: context.decodeRequestedUrl! }),
                    onDone: {
                      target: "decoded",
                      actions: "markDecoded",
                    },
                    onError: {
                      target: "failed",
                      actions: assign({
                        decodeError: ({ event }) => errorMessage(event.error, DECODE_FAILED_MESSAGE),
                      }),
                    },
                  },
                },
                decoded: {
                  always: { guard: "decodeRequestChanged", target: "checking" },
                },
                notNeeded: {},
                failed: {
                  always: { guard: "decodeRequestChanged", target: "checking" },
                },
              },
            },
          },
        },
      },
    },
    failed: {
      entry: assign({
        read: null,
        decodeRequestedUrl: null,
        decodedUrl: null,
        decodeError: null,
      }),
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

export function stopPlaybackMediaLifecycleActorsForJourney<T extends { stop(): void }>(
  actors: Map<string, T>,
  journeyId: string,
): void {
  const prefix = `${journeyId}:`;
  for (const [key, actor] of actors) {
    if (!key.startsWith(prefix)) continue;
    actor.stop();
    actors.delete(key);
  }
}

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
