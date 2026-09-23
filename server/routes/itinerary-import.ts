/**
 * #512: the server side of importing an itinerary.
 *
 * It does two things and refuses to do a third. It reads the page behind a
 * shared link through the configured, SSRF-guarded fetch adapter, and it asks
 * the configured recogniser to read a page, an image segment or pasted text
 * into versioned structured candidates. It writes nothing: no Journey, no
 * Route Point, no media, no evidence. The member reviews the candidates in the
 * Composer and saves through the existing authorized, revision-guarded path,
 * which is what keeps an extraction from ever becoming a write nobody approved.
 *
 * Every refusal names the stage it happened in — `source-access`,
 * `content-read` or `ai-extraction` — because a link this deployment cannot
 * reach, a page it cannot yet render and a reading that failed are three
 * different problems with three different next steps, and none of them is
 * "the link is invalid".
 *
 * A long screenshot arrives as bounded segments, one request each, carrying
 * their own index. Each segment is a reading of one plan, not a plan of its
 * own; the client assembles them into the single draft it reviews. The
 * segments stay inside the app's 512 KB request envelope by construction, so
 * no import can widen the body limit every other route is held to.
 */

import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { createItineraryRecognizer } from "../itinerary/create-itinerary-recognition";
import {
  ItineraryImportStageError,
  withRecognitionTimeout,
  type ItineraryRecognitionRequest,
} from "../itinerary/itinerary-recognition";
import {
  fetchItinerarySourcePage,
  type AddressLookup,
  type ItinerarySourceDriver,
  type SourcePageTransport,
} from "../itinerary/itinerary-source-fetch";
import { pageRecognitionDocument } from "../itinerary/recognition-document";
import { readJsonObject } from "./json-body";

/** What a member submits. Nothing else about them reaches a provider. */
const MAX_TEXT_LENGTH = 200_000;
const MAX_IMAGE_BASE64_LENGTH = 400_000;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// #512: an imported plan is never cached by a shared proxy, and the reading is
// owner-only for exactly the reason the recorded-track route is.
export const ITINERARY_IMPORT_CACHE_CONTROL = "private, no-store, max-age=0";

export type ItineraryImportDependencies = {
  fetcher?: typeof fetch;
  lookup?: AddressLookup;
  sourceTransport?: SourcePageTransport;
};

/**
 * Overridable only so a test can hand in a fetcher and a resolver. Nothing in
 * the request can reach these, so no caller can choose its own network.
 */
export const itineraryImportDependencies: ItineraryImportDependencies = {};

export const itineraryImportRoutes = new Hono();

itineraryImportRoutes.get("/capabilities", async (context) => {
  await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", ITINERARY_IMPORT_CACHE_CONTROL);
  // Truthful about what this deployment can actually do, so the client never
  // offers an entry point that would fail, and never claims one that is off.
  return context.json({
    recognition: {
      configured: serverConfig.itineraryRecognitionDriver !== "disabled",
      recognizerVersion: serverConfig.itineraryRecognitionDriver === "disabled"
        ? null
        : `http-model/${serverConfig.itineraryRecognitionModel}`,
      timeoutMs: serverConfig.itineraryRecognitionTimeoutMs,
    },
    linkFetch: {
      configured: serverConfig.itinerarySourceFetchDriver !== "disabled",
      driver: serverConfig.itinerarySourceFetchDriver,
      timeoutMs: serverConfig.itinerarySourceFetchTimeoutMs,
    },
  });
});

itineraryImportRoutes.post("/", async (context) => {
  await requireAtlasAccess(context.req.raw, "update");
  context.header("Cache-Control", ITINERARY_IMPORT_CACHE_CONTROL);

  const body = await readJsonObject(() => context.req.json());
  const source = body?.source;
  if (source !== "link" && source !== "image" && source !== "text") {
    return context.json({ error: "INVALID_IMPORT_REQUEST" }, 400);
  }

  let request: ItineraryRecognitionRequest;
  let page: Awaited<ReturnType<typeof fetchItinerarySourcePage>> | null = null;

  if (source === "link") {
    const link = body?.link;
    if (typeof link !== "string" || link.length === 0 || link.length > 2_048) {
      return context.json({ error: "INVALID_IMPORT_REQUEST" }, 400);
    }
    page = await fetchItinerarySourcePage(link, {
      driver: serverConfig.itinerarySourceFetchDriver as ItinerarySourceDriver,
      renderUrl: serverConfig.itinerarySourceRenderUrl,
      timeoutMs: serverConfig.itinerarySourceFetchTimeoutMs,
      maxBytes: serverConfig.itinerarySourceMaxBytes,
      fetcher: itineraryImportDependencies.fetcher,
      lookup: itineraryImportDependencies.lookup,
      transport: itineraryImportDependencies.sourceTransport,
    });
    // The page is minimised before anything is decided about it: markup,
    // scripts and every link the page printed - the signed share URL among
    // them - are gone, and what is left is the text a person would have read.
    // A body that carries no such text is empty for this purpose even if its
    // markup was large.
    request = pageRecognitionDocument(page);
    if (request.text.trim().length === 0) {
      throw new ItineraryImportStageError(
        "content-read",
        "ITINERARY_SOURCE_EMPTY",
        "The page was reached but carried no readable itinerary content",
      );
    }
  } else if (source === "text") {
    const text = body?.text;
    if (
      typeof text !== "string"
      || text.trim().length === 0
      || text.length > MAX_TEXT_LENGTH
    ) {
      return context.json({ error: "INVALID_IMPORT_REQUEST" }, 400);
    }
    request = { kind: "text", text };
  } else {
    const image = body?.image as Record<string, unknown> | undefined;
    const mimeType = image?.mimeType;
    const base64 = image?.base64;
    if (
      typeof mimeType !== "string"
      || !IMAGE_MIME_TYPES.has(mimeType)
      || typeof base64 !== "string"
      || base64.length === 0
    ) {
      return context.json({ error: "INVALID_IMPORT_REQUEST" }, 400);
    }
    if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
      // The client already slices a long screenshot into readable segments;
      // this is the ceiling one segment is built against, named as itself
      // rather than arriving as the transport's generic 413.
      return context.json({ error: "ITINERARY_IMAGE_SEGMENT_TOO_LARGE" }, 413);
    }
    request = { kind: "image", mimeType, base64 };
  }

  const recognizer = createItineraryRecognizer({
    driver: serverConfig.itineraryRecognitionDriver,
    baseUrl: serverConfig.itineraryRecognitionBaseUrl,
    apiKey: serverConfig.itineraryRecognitionApiKey,
    model: serverConfig.itineraryRecognitionModel,
    fetcher: itineraryImportDependencies.fetcher,
  });

  const candidates = await withRecognitionTimeout(
    serverConfig.itineraryRecognitionTimeoutMs,
    (signal) => recognizer.recognize(request, { signal }),
  );

  return context.json({
    recognition: candidates,
    // What actually happened, kept beside the reading rather than folded into
    // it, so a draft can say where it came from without the recogniser being
    // the one who says so.
    sourceRead: page
      ? { readVia: page.readVia, contentType: page.contentType }
      : { readVia: source, contentType: null },
  });
});
