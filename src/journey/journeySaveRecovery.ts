import type { Journey, JourneyInput, RoutePointInput } from "./types";

export type JourneySaveRecoveryDecision =
  | { status: "already-persisted"; journey: Journey }
  | { status: "not-persisted" };

export type JourneySaveCallbackScope = "initial-save" | "media-retry";

function canonicalOccurredAt(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function canonicalPoint(point: RoutePointInput | Journey["routePoints"][number]) {
  return {
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
    label: point.label.trim(),
    isStop: point.isStop,
    occurredAt: canonicalOccurredAt(point.occurredAt),
    note: point.note ?? null,
  };
}

function matchesSubmittedDraft(input: JourneyInput, journey: Journey) {
  if (journey.title !== input.title.trim()) return false;
  if (journey.startedOn !== input.startedOn) return false;
  if (journey.endedOn !== (input.endedOn || null)) return false;
  if (journey.note !== input.note.trim()) return false;
  if (journey.lightColor !== input.lightColor) return false;
  if ((journey.lightEffect ?? null) !== (input.lightEffect ?? null)) return false;
  if (journey.routePoints.length !== input.routePoints.length) return false;
  return input.routePoints.every((point, index) => {
    const left = canonicalPoint(point);
    const right = canonicalPoint(journey.routePoints[index]);
    return left.latitude === right.latitude
      && left.longitude === right.longitude
      && left.label === right.label
      && left.isStop === right.isStop
      && left.occurredAt === right.occurredAt
      && left.note === right.note;
  });
}

export function resolveJourneySaveRecovery(
  submittedDraft: JourneyInput,
  journeys: readonly Journey[],
  options: { knownJourneyIdsBeforeCreate?: ReadonlySet<string> } = {},
): JourneySaveRecoveryDecision {
  const knownIds = options.knownJourneyIdsBeforeCreate;
  const matches = journeys
    .filter((journey) => !knownIds?.has(journey.id))
    .filter((journey) => matchesSubmittedDraft(submittedDraft, journey))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (matches.length > 0) return { status: "already-persisted", journey: matches[0] };
  return { status: "not-persisted" };
}

export function resolveJourneyArrivalHandoff({
  journeyId,
  editingJourneyId,
  callbackScope,
}: {
  journeyId: string;
  editingJourneyId: string | null;
  callbackScope: JourneySaveCallbackScope;
}) {
  if (callbackScope !== "initial-save") return null;
  if (editingJourneyId === journeyId) return null;
  return journeyId;
}
