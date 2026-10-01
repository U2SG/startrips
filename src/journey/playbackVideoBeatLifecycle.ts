import { assign, createActor, setup, type SnapshotFrom } from "xstate";
import type { VideoTrimSeekStatus } from "./videoTrimPlayback";

export const PLAYBACK_VIDEO_WATCHDOG_MS = 4_000;

export type PlaybackVideoBeatInput = {
  beatKey: string;
  assetId: string;
  stepIndex: number;
  hasTrim: boolean;
  paused?: boolean;
};

export type PlaybackVideoBeatEvent =
  | { type: "READ_READY"; beatKey: string }
  | { type: "POSITION_READY"; beatKey: string }
  | { type: "POSITION_UNAVAILABLE"; beatKey: string }
  | { type: "PLAYING"; beatKey: string }
  | { type: "TIME_PROGRESS"; beatKey: string }
  | { type: "STALLED"; beatKey: string }
  | { type: "FAILED"; beatKey: string }
  | { type: "ENDED"; beatKey: string }
  | { type: "PAUSE"; beatKey: string }
  | { type: "RESUME"; beatKey: string };

type PlaybackVideoBeatContext = Omit<PlaybackVideoBeatInput, "paused"> & {
  trimStatus: VideoTrimSeekStatus | null;
  paused: boolean;
};

export const playbackVideoBeatLifecycleMachine = setup({
  types: {
    context: {} as PlaybackVideoBeatContext,
    events: {} as PlaybackVideoBeatEvent,
    input: {} as PlaybackVideoBeatInput,
  },
  guards: {
    currentBeat: ({ context, event }) => event.beatKey === context.beatKey,
    hasTrim: ({ context }) => context.hasTrim,
  },
  delays: {
    watchdog: PLAYBACK_VIDEO_WATCHDOG_MS,
  },
  actions: {
    trimPositioning: assign({
      trimStatus: ({ context }) => context.hasTrim ? "positioning" : null,
    }),
    trimPlaying: assign({
      trimStatus: ({ context }) => context.hasTrim && context.trimStatus !== "unavailable"
        ? "playing"
        : context.trimStatus,
    }),
    trimBuffering: assign({
      trimStatus: ({ context }) => context.hasTrim && context.trimStatus !== "unavailable"
        ? "buffering"
        : context.trimStatus,
    }),
    trimUnavailable: assign({
      trimStatus: ({ context }) => context.hasTrim ? "unavailable" : null,
    }),
    markPaused: assign({ paused: true }),
    markResumed: assign({ paused: false }),
  },
}).createMachine({
  id: "playbackVideoBeatLifecycle",
  context: ({ input }) => ({
    beatKey: input.beatKey,
    assetId: input.assetId,
    stepIndex: input.stepIndex,
    hasTrim: input.hasTrim,
    trimStatus: input.hasTrim ? "positioning" : null,
    paused: Boolean(input.paused),
  }),
  initial: "waitingForRead",
  states: {
    waitingForRead: {
      on: {
        READ_READY: [
          {
            guard: ({ context, event }) => event.beatKey === context.beatKey && context.hasTrim && context.paused,
            target: "pausedPositioning",
            actions: "trimPositioning",
          },
          { guard: ({ context, event }) => event.beatKey === context.beatKey && context.hasTrim, target: "positioning", actions: "trimPositioning" },
          {
            guard: ({ context, event }) => event.beatKey === context.beatKey && context.paused,
            target: "pausedStarting",
          },
          { guard: "currentBeat", target: "starting" },
        ],
        PAUSE: { guard: "currentBeat", actions: "markPaused" },
        RESUME: { guard: "currentBeat", actions: "markResumed" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
      },
    },
    starting: {
      after: { watchdog: { target: "fallback", actions: "trimUnavailable" } },
      on: {
        PLAYING: { guard: "currentBeat", target: "playing", actions: "trimPlaying" },
        TIME_PROGRESS: { guard: "currentBeat", target: "playing", actions: "trimPlaying" },
        STALLED: { guard: "currentBeat", target: "buffering", actions: "trimBuffering" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        ENDED: { guard: "currentBeat", target: "ended" },
        PAUSE: { guard: "currentBeat", target: "pausedStarting", actions: "markPaused" },
      },
    },
    pausedStarting: {
      on: {
        RESUME: { guard: "currentBeat", target: "starting", actions: "markResumed" },
        PLAYING: { guard: "currentBeat", target: "pausedPlaying", actions: "trimPlaying" },
        TIME_PROGRESS: { guard: "currentBeat", target: "pausedPlaying", actions: "trimPlaying" },
        STALLED: { guard: "currentBeat", target: "pausedBuffering", actions: "trimBuffering" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        ENDED: { guard: "currentBeat", target: "ended" },
      },
    },
    positioning: {
      after: { watchdog: { target: "starting", actions: "trimUnavailable" } },
      on: {
        POSITION_READY: { guard: "currentBeat", target: "starting", actions: "trimPlaying" },
        POSITION_UNAVAILABLE: { guard: "currentBeat", target: "starting", actions: "trimUnavailable" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        PAUSE: { guard: "currentBeat", target: "pausedPositioning", actions: "markPaused" },
      },
    },
    pausedPositioning: {
      on: {
        RESUME: { guard: "currentBeat", target: "positioning", actions: "markResumed" },
        POSITION_READY: { guard: "currentBeat", target: "pausedStarting", actions: "trimPlaying" },
        POSITION_UNAVAILABLE: { guard: "currentBeat", target: "pausedStarting", actions: "trimUnavailable" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
      },
    },
    playing: {
      on: {
        PLAYING: { guard: "currentBeat", actions: "trimPlaying" },
        TIME_PROGRESS: { guard: "currentBeat", actions: "trimPlaying" },
        STALLED: { guard: "currentBeat", target: "buffering", actions: "trimBuffering" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        ENDED: { guard: "currentBeat", target: "ended" },
        PAUSE: { guard: "currentBeat", target: "pausedPlaying", actions: "markPaused" },
      },
    },
    pausedPlaying: {
      on: {
        RESUME: { guard: "currentBeat", target: "playing", actions: "markResumed" },
        PLAYING: { guard: "currentBeat", actions: "trimPlaying" },
        TIME_PROGRESS: { guard: "currentBeat", actions: "trimPlaying" },
        STALLED: { guard: "currentBeat", target: "pausedBuffering", actions: "trimBuffering" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        ENDED: { guard: "currentBeat", target: "ended" },
      },
    },
    buffering: {
      after: { watchdog: { target: "fallback", actions: "trimUnavailable" } },
      on: {
        PLAYING: { guard: "currentBeat", target: "playing", actions: "trimPlaying" },
        TIME_PROGRESS: { guard: "currentBeat", target: "playing", actions: "trimPlaying" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        ENDED: { guard: "currentBeat", target: "ended" },
        PAUSE: { guard: "currentBeat", target: "pausedBuffering", actions: "markPaused" },
      },
    },
    pausedBuffering: {
      on: {
        RESUME: { guard: "currentBeat", target: "buffering", actions: "markResumed" },
        PLAYING: { guard: "currentBeat", target: "pausedPlaying", actions: "trimPlaying" },
        TIME_PROGRESS: { guard: "currentBeat", target: "pausedPlaying", actions: "trimPlaying" },
        FAILED: { guard: "currentBeat", target: "fallback", actions: "trimUnavailable" },
        ENDED: { guard: "currentBeat", target: "ended" },
      },
    },
    fallback: {
      on: {
        ENDED: { guard: "currentBeat", target: "ended" },
      },
    },
    ended: {},
  },
});

export function createPlaybackVideoBeatLifecycleActor(input: PlaybackVideoBeatInput) {
  return createActor(playbackVideoBeatLifecycleMachine, { input });
}

export type PlaybackVideoBeatActor = ReturnType<typeof createPlaybackVideoBeatLifecycleActor>;

export type PlaybackVideoBeatSnapshot = SnapshotFrom<typeof playbackVideoBeatLifecycleMachine>;

export function playbackVideoBeatTrimStatus(
  snapshot: PlaybackVideoBeatSnapshot | null,
): VideoTrimSeekStatus | null {
  return snapshot?.context.trimStatus ?? null;
}

export function playbackVideoBeatFailed(snapshot: PlaybackVideoBeatSnapshot | null): boolean {
  return snapshot?.matches("fallback") ?? false;
}

export function playbackVideoBeatBuffering(snapshot: PlaybackVideoBeatSnapshot | null): boolean {
  return snapshot?.matches("buffering") || snapshot?.matches("pausedBuffering") || false;
}

export function playbackVideoBeatEventIsCurrent(
  snapshot: PlaybackVideoBeatSnapshot | null,
  beatKey: string,
): boolean {
  return Boolean(snapshot && snapshot.context.beatKey === beatKey && snapshot.status === "active");
}
