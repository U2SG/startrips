import type { JournalEvent } from "./dailyJournal";
import type { JourneyMediaAsset } from "./types";

/** Point media is context for the place, never evidence of when this event happened. */
export function journalMediaGroups(event: JournalEvent, media: JourneyMediaAsset[]) {
  const visual = media.filter(asset => /^(image|video)\//.test(asset.mimeType));
  const explicit = new Set(event.mediaIds);
  return {
    manual: [...new Set(visual.filter(asset => explicit.has(asset.id)).map(asset => asset.id))],
    place: [...new Set(visual.filter(asset => !explicit.has(asset.id) && event.status === "actual"
      && !!event.routePointId && asset.routePointId === event.routePointId).map(asset => asset.id))],
  };
}

export function firstJournalPlaceMediaEvents(events: JournalEvent[], media: JourneyMediaAsset[]) {
  const first = new Map<string, string>();
  for (const event of events) if (event.routePointId && !first.has(event.routePointId) && journalMediaGroups(event, media).place.length) first.set(event.routePointId, event.id);
  return first;
}
