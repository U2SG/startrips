import type { Journey } from "./types";

export type PlaybackEntrySource = "atlas" | "story";
export type StorySnapState = "closed" | "in-context" | "expanded";
export type PlaybackReturnReason = "exited" | "completed";
export type PlaybackReturnFallbackReason =
  | "none"
  | "asset-unavailable"
  | "route-point-unavailable"
  | "journey-unavailable";

export type PlaybackLogicalPosition = {
  journeyId: string;
  routePointId: string | null;
  assetId: string | null;
};

export type PlaybackEntry = PlaybackLogicalPosition & {
  intentRevision: number;
  source: PlaybackEntrySource;
  storySnapState: StorySnapState;
};

export type PlaybackReturnResolution =
  | {
      surface: "story";
      reason: "exited";
      fallbackReason: Exclude<PlaybackReturnFallbackReason, "journey-unavailable">;
      journeyId: string;
      routePointId: string | null;
      assetId: string | null;
      storySnapState: StorySnapState;
    }
  | {
      surface: "atlas";
      reason: PlaybackReturnReason;
      fallbackReason: "none" | "journey-unavailable";
      journeyId: string | null;
      routePointId: null;
      assetId: null;
      storySnapState: "closed";
    };

export function capturePlaybackEntry(input: PlaybackEntry): PlaybackEntry {
  return {
    journeyId: input.journeyId,
    routePointId: input.routePointId,
    assetId: input.assetId,
    intentRevision: input.intentRevision,
    source: input.source,
    storySnapState: input.storySnapState,
  };
}

function specificCommittedPosition(
  entry: PlaybackEntry,
  committedPosition: PlaybackLogicalPosition | null,
): PlaybackLogicalPosition {
  if (
    committedPosition
    && committedPosition.journeyId === entry.journeyId
    && (committedPosition.routePointId !== null || committedPosition.assetId !== null)
  ) {
    return committedPosition;
  }
  return entry;
}

export function resolvePlaybackReturn({
  entry,
  committedPosition,
  reason,
  currentIntentRevision,
  journeys,
}: {
  entry: PlaybackEntry;
  committedPosition: PlaybackLogicalPosition | null;
  reason: PlaybackReturnReason;
  currentIntentRevision: number;
  journeys: readonly Journey[];
}): PlaybackReturnResolution | null {
  if (entry.intentRevision < currentIntentRevision) return null;

  const journey = journeys.find((candidate) => candidate.id === entry.journeyId) ?? null;
  if (!journey) {
    return {
      surface: "atlas",
      reason,
      fallbackReason: "journey-unavailable",
      journeyId: null,
      routePointId: null,
      assetId: null,
      storySnapState: "closed",
    };
  }

  if (reason === "completed") {
    return {
      surface: "atlas",
      reason: "completed",
      fallbackReason: "none",
      journeyId: journey.id,
      routePointId: null,
      assetId: null,
      storySnapState: "closed",
    };
  }

  const target = specificCommittedPosition(entry, committedPosition);
  if (target.assetId !== null) {
    const asset = journey.media.find((candidate) => candidate.id === target.assetId) ?? null;
    if (asset) {
      const currentRoutePointId = asset.routePointId;
      if (
        currentRoutePointId !== null
        && !journey.routePoints.some((point) => point.id === currentRoutePointId)
      ) {
        return {
          surface: "story",
          reason: "exited",
          fallbackReason: "route-point-unavailable",
          journeyId: journey.id,
          routePointId: null,
          assetId: null,
          storySnapState: entry.storySnapState,
        };
      }
      return {
        surface: "story",
        reason: "exited",
        fallbackReason: "none",
        journeyId: journey.id,
        routePointId: currentRoutePointId,
        assetId: asset.id,
        storySnapState: entry.storySnapState,
      };
    }

    if (
      target.routePointId !== null
      && journey.routePoints.some((point) => point.id === target.routePointId)
    ) {
      return {
        surface: "story",
        reason: "exited",
        fallbackReason: "asset-unavailable",
        journeyId: journey.id,
        routePointId: target.routePointId,
        assetId: null,
        storySnapState: entry.storySnapState,
      };
    }
  }

  if (target.routePointId !== null) {
    if (journey.routePoints.some((point) => point.id === target.routePointId)) {
      return {
        surface: "story",
        reason: "exited",
        fallbackReason: target.assetId === null ? "none" : "asset-unavailable",
        journeyId: journey.id,
        routePointId: target.routePointId,
        assetId: null,
        storySnapState: entry.storySnapState,
      };
    }
    return {
      surface: "story",
      reason: "exited",
      fallbackReason: "route-point-unavailable",
      journeyId: journey.id,
      routePointId: null,
      assetId: null,
      storySnapState: entry.storySnapState,
    };
  }

  return {
    surface: "story",
    reason: "exited",
    fallbackReason: target.assetId === null ? "none" : "asset-unavailable",
    journeyId: journey.id,
    routePointId: null,
    assetId: null,
    storySnapState: entry.storySnapState,
  };
}
