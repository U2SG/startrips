import type { Journey, JourneyInput, RoutePointInput } from "./types";

export type JourneySaveRecoveryDecision =
  | { status: "not-persisted" }
  | { status: "confirmation-required"; matchingJourneyId: string }
  | { status: "ambiguous"; matchingJourneyIds: string[] };

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
    note: typeof point.note === "string" && point.note.trim().length > 0
      ? point.note
      : null,
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
    .filter((journey) => matchesSubmittedDraft(submittedDraft, journey));
  // Canonical equality proves only that a matching Journey appeared after the
  // pre-create snapshot. Without server-bound attempt provenance it cannot
  // prove that this specific POST created the Journey, so a single match is
  // confirmation-only rather than automatically adoptable.
  if (matches.length === 1) {
    return { status: "confirmation-required", matchingJourneyId: matches[0].id };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      matchingJourneyIds: matches.map((journey) => journey.id).sort(),
    };
  }
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
