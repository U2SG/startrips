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

import {
  ItineraryImportStageError,
  ItineraryRecognitionUnavailableError,
  parseRecognitionCandidates,
  type ItineraryRecognitionCandidates,
  type ItineraryRecognitionRequest,
  type ItineraryRecognizer,
} from "./itinerary-recognition";

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
    return parseRecognitionCandidates(
      await response.json(),
      this.recognizerVersion,
    );
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
