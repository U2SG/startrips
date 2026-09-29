/**
 * #512: which recogniser a deployment runs, decided at deployment time.
 *
 * `disabled` is the default and the honest one: it reads nothing and says so,
 * so a deployment with no recognition provider still imports pasted text
 * through `src/journey/itineraryText.ts` and still refuses to pretend.
 *
 * `http-model` is deliberately provider-shaped rather than vendor-shaped. The
 * endpoint, the credential and the model build are configuration, so naming
 * one vendor's current model never becomes part of the domain contract, and a
 * newer build is a configuration change rather than a code change. The
 * credential is read here and never leaves the server.
 */

import type { ItineraryOrganizationDecision } from "../../src/journey/itineraryImport";
import {
  ItineraryImportStageError,
  ItineraryRecognitionUnavailableError,
  parseRecognitionCandidates,
  withRecognitionTimeout,
  type ItineraryRecognitionCandidates,
  type ItineraryRecognitionRequest,
  type ItineraryRecognizer,
} from "./itinerary-recognition";
import { groundTextItineraryDates } from "./recognition-document";

export type ItineraryLocationReviewPlan = {
  sourceTitle: string | null;
  days: Array<{ dayNumber: number; title: string | null; region: string | null }>;
  entries: Array<{
    index: number;
    name: string;
    aliases: string[];
    dayNumber: number;
    role: string;
    sourceInvalid: boolean;
    countryCode: string | null;
    searchArea: string | null;
    candidates: Array<{ id: string; label: string; context: string; countryCode: string }>;
  }>;
};

export type ItineraryLocationReviewDecision = ItineraryOrganizationDecision & {
  index: number;
  candidateId: string | null;
  correctedQuery: string | null;
};

/** The model can pick a supplied provider ID or suggest another query, never a coordinate. */
export async function reviewItineraryLocations(
  plan: ItineraryLocationReviewPlan,
  options: HttpModelOptions & { timeoutMs: number },
): Promise<ItineraryLocationReviewDecision[]> {
  if (!options.baseUrl) throw new ItineraryRecognitionUnavailableError();
  return withRecognitionTimeout(options.timeoutMs, async (signal) => {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(options.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          contractVersion: 1,
          document: { kind: "review-locations", plan },
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ItineraryImportStageError("ai-review", "ITINERARY_REVIEW_UNREACHABLE", "The location review provider could not be reached");
    }
    if (!response.ok) {
      throw new ItineraryImportStageError("ai-review", "ITINERARY_REVIEW_FAILED", `The location review provider answered ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (payload?.contractVersion !== 1 || !Array.isArray(payload.decisions)) {
      throw new ItineraryImportStageError("ai-review", "ITINERARY_REVIEW_MALFORMED", "The location review response was invalid");
    }
    const decisions: ItineraryLocationReviewDecision[] = [];
    const seen = new Set<number>();
    for (const raw of payload.decisions) {
      if (!raw || typeof raw !== "object") continue;
      const decision = raw as Record<string, unknown>;
      const index = decision.index;
      if (typeof index !== "number" || !Number.isInteger(index) || seen.has(index)) continue;
      const entry = plan.entries.find((candidate) => candidate.index === index);
      if (!entry) continue;
      seen.add(index);
      const candidateId = typeof decision.candidateId === "string"
        && entry.candidates.some((candidate) => candidate.id === decision.candidateId)
          ? decision.candidateId : null;
      const correctedQuery = typeof decision.correctedQuery === "string"
        && decision.correctedQuery.trim().length >= 2
        && decision.correctedQuery.length <= 120
        && !/[\r\n\x00-\x1f]/.test(decision.correctedQuery)
          ? decision.correctedQuery.trim() : null;
      const anchor = decision.stayAnchorIndex;
      const anchorValid = anchor === null || (typeof anchor === "number"
        && Number.isInteger(anchor) && anchor !== index
        && plan.entries.some((candidate) => candidate.index === anchor && !candidate.sourceInvalid));
      const region = decision.regionContext;
      const regionValid = region === null || (typeof region === "string"
        && region.trim().length <= 120 && !/[\r\n\x00-\x1f]/.test(region));
      decisions.push({
        index,
        candidateId,
        correctedQuery,
        ...(typeof decision.isStop === "boolean" && !entry.sourceInvalid
          ? { isStop: decision.isStop } : {}),
        ...(anchorValid ? { stayAnchorIndex: anchor as number | null } : {}),
        ...(regionValid
          ? { regionContext: typeof region === "string" ? region.trim() || null : null }
          : {}),
      });
    }

    // The model may only bind a via to the exact nearest previous/next Stop it
    // classified in this same ordered plan. Invalid/self/non-Stop/non-adjacent
    // targets collapse to independent rather than becoming stored authority.
    const stopIndexes = decisions
      .filter((decision) => decision.isStop === true)
      .map((decision) => decision.index)
      .sort((left, right) => left - right);
    return decisions.map((decision) => {
      if (decision.isStop === true) return { ...decision, stayAnchorIndex: null };
      const previous = stopIndexes.filter((index) => index < decision.index).at(-1);
      const next = stopIndexes.find((index) => index > decision.index);
      const requested = decision.stayAnchorIndex;
      const validOwner = requested !== null && requested !== undefined
        && (requested === previous || requested === next);
      return { ...decision, stayAnchorIndex: validOwner ? requested : null };
    });
  }, "ai-review");
}

export class DisabledItineraryRecognizer implements ItineraryRecognizer {
  readonly driver = "disabled";
  readonly recognizerVersion = "disabled";

  async recognize(): Promise<ItineraryRecognitionCandidates> {
    throw new ItineraryRecognitionUnavailableError();
  }
}

type HttpModelOptions = {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fetcher?: typeof fetch;
};

export class HttpModelItineraryRecognizer implements ItineraryRecognizer {
  readonly driver = "http-model";
  readonly recognizerVersion: string;
  readonly #options: HttpModelOptions;

  constructor(options: HttpModelOptions) {
    this.#options = options;
    this.recognizerVersion = `http-model/${options.model}`;
  }

  async recognize(
    request: ItineraryRecognitionRequest,
    options: { signal?: AbortSignal },
  ): Promise<ItineraryRecognitionCandidates> {
    const fetcher = this.#options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(this.#options.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#options.apiKey
            ? { authorization: `Bearer ${this.#options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.#options.model,
          contractVersion: 1,
          document: request,
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ItineraryImportStageError(
        "ai-extraction",
        "ITINERARY_RECOGNITION_UNREACHABLE",
        "The recognition provider could not be reached",
      );
    }
    if (!response.ok) {
      throw new ItineraryImportStageError(
        "ai-extraction",
        "ITINERARY_RECOGNITION_FAILED",
        `The recognition provider answered ${response.status}`,
      );
    }
    // Whatever comes back is a proposal until this passes.
    const reading = parseRecognitionCandidates(
      await response.json(),
      this.recognizerVersion,
    );
    return request.kind === "image"
      ? reading
      : groundTextItineraryDates(reading, request.text);
  }
}

export function createItineraryRecognizer(options: {
  driver: string;
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  fetcher?: typeof fetch;
}): ItineraryRecognizer {
  if (options.driver === "disabled") return new DisabledItineraryRecognizer();
  if (options.driver === "http-model") {
    if (!options.baseUrl) {
      throw new Error(
        "ITINERARY_RECOGNITION_BASE_URL is required when ITINERARY_RECOGNITION_DRIVER=http-model",
      );
    }
    return new HttpModelItineraryRecognizer({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      fetcher: options.fetcher,
    });
  }
  throw new Error(
    `Itinerary recognition driver "${options.driver}" has no installed adapter`,
  );
}
