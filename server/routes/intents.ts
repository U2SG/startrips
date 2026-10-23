/**
 * One-sentence share: turning what a member wrote into a proposed share
 * selection.
 *
 * It writes nothing and never creates a share. The member sees the proposal
 * in the share dialog, may change it, and creates the link through
 * `POST /api/shares`, under that route's authorization and validation.
 *
 * The Atlas comes from the session only. The model sees the Atlas's live
 * Journeys as id, title and dates — no coordinates, notes or media — and its
 * answer is narrowed to ids from that same list before the member sees it.
 *
 * `POST /share/media` is the "只分享风景图" step: on request only, it judges
 * the photos of the Journeys the member chose and answers which may be
 * shared. It writes only its own per-asset cache and never creates a share;
 * the result reaches a link only as `mediaAssetIds` on `POST /api/shares`.
 *
 * `POST /route` is the command bar: it classifies one sentence among the
 * intents the member's surface offers, then calls that intent's reader under
 * the intent's own permission. It writes nothing either.
 * `POST /route-order` is the Composer's one-sentence reorder: it answers a
 * proposed order of the Route Points the member is editing and writes
 * nothing; the member applies it to the draft and saves the Journey.
 * `POST /assign-media` is the Story's one-sentence photo assignment: it
 * answers one Route Point of a Journey of this Atlas for the photos the
 * member selected (which it never sees) and writes nothing; the Story moves
 * them through `POST /api/uploads/assets/move`.
 */

import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import type { AtlasAction } from "../authorization/permissions";
import { serverConfig } from "../config";
import {
  boundShareIntentProposal,
  createShareIntentReader,
  ShareIntentError,
  ShareIntentUnavailableError,
} from "../intents/create-share-intent";
import {
  createHttpPersonClassifier,
  filterShareMediaWithoutPeople,
} from "../intents/share-media-filter";
import {
  createRouteOrderIntentReader,
  MAX_ROUTE_ORDER_TEXT_LENGTH,
  parseRouteOrderRequest,
  RouteOrderIntentUnavailableError,
} from "../intents/route-order-intent";
import {
  AssignMediaIntentUnavailableError,
  MAX_ASSIGN_MEDIA_TEXT_LENGTH,
  parseAssignMediaRequest,
  parseAssignMediaSelection,
  readAssignMediaIntent,
} from "../intents/assign-media-intent";
import {
  availableRouterIntents,
  classifyCommand,
  MAX_JOURNEY_SENTENCE_LENGTH,
  narrowOfferedIntents,
  readNavigateIntent,
  RouterIntentError,
  RouterIntentUnavailableError,
  UNSUPPORTED_INTENT,
  type RoutedIntent,
} from "../intents/intent-router";
import {
  listJourneyRoutePointLabelsForAtlas,
  listJourneyShareCandidatesForAtlas,
} from "../repositories/journey-repository";
import {
  listShareMediaFilterAssets,
  saveShareMediaClassifications,
} from "../repositories/share-media-filter-repository";
import type { MultipartStorage } from "../storage/multipart-storage";
import { getMultipartStorage } from "../storage/storage-registry";
import { readJsonObject } from "./json-body";
import { MAX_SHARE_JOURNEYS, MAX_SHARE_MEDIA_ASSETS } from "./shares";

/** A sentence, not a document. */
export const MAX_SHARE_INTENT_TEXT_LENGTH = 300;

/**
 * The most recent Journeys a model is shown. A bound on what one request can
 * send to a provider; an Atlas larger than this still shares everything by
 * hand, and a sentence about an older Journey comes back as `unmatched`.
 */
export const MAX_SHARE_INTENT_CANDIDATES = 200;

/** Journey titles are owner-private, and so is any proposal built from them. */
export const SHARE_INTENT_CACHE_CONTROL = "private, no-store";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Overridable only so a test can hand in a fetcher, a clock and storage. */
export const shareIntentDependencies: {
  fetcher?: typeof fetch;
  now?: () => Date;
  storage?: (driver: string) => Pick<MultipartStorage, "readObjectHead">;
} = {};

/** The media filter needs the text provider and a vision model on it. */
function mediaFilterConfigured() {
  return serverConfig.intentDriver === "http-model" && serverConfig.intentVisionModel !== null;
}

export const intentRoutes = new Hono();

intentRoutes.get("/capabilities", async (context) => {
  await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  return context.json({
    share: {
      configured: serverConfig.intentDriver !== "disabled",
      mediaFilter: mediaFilterConfigured(),
    },
    routeOrder: { configured: serverConfig.intentDriver === "http-model" },
    // The command bar renders only when at least one intent can be routed.
    router: (() => {
      const intents = availableRouterIntents(routerConfig());
      return { configured: intents.length > 0, intents };
    })(),
  });
});

intentRoutes.post("/share", async (context) => {
  // `create`, matching the share this proposal is for, so a member who could
  // not create the link cannot spend the provider on proposing one.
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  const body = await readJsonObject(() => context.req.json());
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (text.length < 1 || text.length > MAX_SHARE_INTENT_TEXT_LENGTH) {
    return context.json(
      { error: "INVALID_SHARE_INTENT", message: "Write one sentence of up to 300 characters" },
      400,
    );
  }
  if (serverConfig.intentDriver === "disabled") throw new ShareIntentUnavailableError();

  const reader = createShareIntentReader({
    driver: serverConfig.intentDriver,
    baseUrl: serverConfig.intentBaseUrl,
    apiKey: serverConfig.intentApiKey,
    model: serverConfig.intentModel,
    timeoutMs: serverConfig.intentTimeoutMs,
    fetcher: shareIntentDependencies.fetcher,
  });
  const candidates = await listJourneyShareCandidatesForAtlas(
    atlas.id,
    MAX_SHARE_INTENT_CANDIDATES,
  );
  const now = shareIntentDependencies.now?.() ?? new Date();
  const reading = await reader.read({
    text,
    // Labelled as the server's UTC date in the system prompt.
    today: now.toISOString().slice(0, 10),
    candidates,
  });
  return context.json({
    proposal: boundShareIntentProposal(reading.proposal, candidates, MAX_SHARE_JOURNEYS),
    model: reading.model,
  });
});

/**
 * One media classification at a time per Atlas, in this process. A second
 * request while one runs answers 409 instead of doubling provider calls.
 */
const mediaFilterInFlight = new Set<string>();

/**
 * Which media of these Journeys may be shared without people. Same `create`
 * guard as the proposal; the Atlas is the session's, and every Journey id is
 * re-checked against it before any media is read or sent.
 *
 * Only a stored preview is ever sent, inline as a data URL. A photo that
 * could not be judged, and every video or other media, is excluded.
 *
 * Batched: one call judges at most `MAX_SHARE_MEDIA_FILTER_UNCLASSIFIED`
 * photos and answers `{ assetIds, excludedCount, unclassifiedCount,
 * remaining, checkedCount, failedAssetIds }`. The caller repeats the same
 * request, adding every `failedAssetIds` to `skipAssetIds`, until
 * `remaining` is 0; only that last answer's `assetIds` may be shared.
 */
intentRoutes.post("/share/media", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  const body = await readJsonObject(() => context.req.json());
  const journeyIds = body?.journeyIds;
  const skipAssetIds = body?.skipAssetIds ?? [];
  if (
    !Array.isArray(journeyIds)
    || journeyIds.length < 1
    || journeyIds.length > MAX_SHARE_JOURNEYS
    || journeyIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || new Set(journeyIds).size !== journeyIds.length
    || !Array.isArray(skipAssetIds)
    || skipAssetIds.length > MAX_SHARE_MEDIA_ASSETS
    || skipAssetIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
  ) {
    return context.json(
      { error: "INVALID_SHARE_MEDIA_FILTER", message: "Choose between 1 and 64 Journeys" },
      400,
    );
  }
  const visionModel = serverConfig.intentVisionModel;
  if (!mediaFilterConfigured() || !visionModel) {
    throw new ShareIntentError(
      "MEDIA_FILTER_UNAVAILABLE",
      "Filtering shared media by content is not configured",
      503,
    );
  }
  if (mediaFilterInFlight.has(atlas.id)) {
    throw new ShareIntentError(
      "SHARE_MEDIA_FILTER_BUSY",
      "Photos of this Atlas are already being checked",
      409,
    );
  }
  mediaFilterInFlight.add(atlas.id);
  try {
    const assets = await listShareMediaFilterAssets(atlas.id, journeyIds as string[], visionModel);
    if (!assets) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
    if (assets.length > MAX_SHARE_MEDIA_ASSETS) {
      throw new ShareIntentError(
        "SHARE_MEDIA_FILTER_TOO_MANY",
        `At most ${MAX_SHARE_MEDIA_ASSETS} media can be shared in one link`,
        400,
      );
    }

    const storage = shareIntentDependencies.storage ?? getMultipartStorage;
    const result = await filterShareMediaWithoutPeople(assets, {
      readPreview: async (asset) => {
        if (!asset.previewStorageKey) return null;
        // One byte past the ceiling: a preview larger than the current ceiling
        // would arrive cut off, and a cut-off image must not be judged.
        const maxBytes = serverConfig.mediaPreviewMaxBytes;
        const head = await storage(asset.storageDriver).readObjectHead({
          key: asset.previewStorageKey,
          maxBytes: maxBytes + 1,
        });
        return head.exists && head.bytes.length <= maxBytes ? head.bytes : null;
      },
      classify: createHttpPersonClassifier({
        baseUrl: serverConfig.intentBaseUrl!,
        apiKey: serverConfig.intentApiKey!,
        model: visionModel,
        timeoutMs: serverConfig.intentTimeoutMs,
        fetcher: shareIntentDependencies.fetcher,
      }),
      saveResults: (results) => saveShareMediaClassifications(results, visionModel),
      skipAssetIds: new Set(skipAssetIds as string[]),
    });
    return context.json(result);
  } finally {
    mediaFilterInFlight.delete(atlas.id);
  }
});

/**
 * A proposed order for the Route Points of the Journey being edited. `update`,
 * the same permission as saving a Journey (`PATCH /api/journeys/:id`), so a
 * member who could not save the order cannot spend the provider on one. Only
 * the sentence and the point labels reach the provider; the answer is an
 * exact permutation of the supplied ids, or `order: null`.
 */
intentRoutes.post("/route-order", async (context) => {
  await requireAtlasAccess(context.req.raw, "update");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  const body = await readJsonObject(() => context.req.json());
  const input = parseRouteOrderRequest(body);
  if (!input) {
    return context.json(
      {
        error: "INVALID_ROUTE_ORDER_INTENT",
        message: "Write one sentence of up to 200 characters about 2 to 64 Route Points",
      },
      400,
    );
  }
  if (serverConfig.intentDriver !== "http-model") throw new RouteOrderIntentUnavailableError();

  const reader = createRouteOrderIntentReader({
    driver: serverConfig.intentDriver,
    baseUrl: serverConfig.intentBaseUrl,
    apiKey: serverConfig.intentApiKey,
    model: serverConfig.intentModel,
    timeoutMs: serverConfig.intentTimeoutMs,
    fetcher: shareIntentDependencies.fetcher,
  });
  const reading = await reader.read(input);
  return context.json({ proposal: reading.proposal, model: reading.model });
});

/**
 * The Route Point labels of a Journey of the session's Atlas, read on the
 * server; `null` (a 404) for any other Journey, before any provider call.
 */
async function assignMediaProposal(atlasId: string, input: { text: string; journeyId: string }) {
  const points = await listJourneyRoutePointLabelsForAtlas(atlasId, input.journeyId);
  if (!points) return null;
  return readAssignMediaIntent(intentModelOptions(), { text: input.text, points });
}

const JOURNEY_NOT_FOUND = { error: "JOURNEY_NOT_FOUND", message: "Journey not found" } as const;

/**
 * A proposed Route Point for the photos selected in the Story. `update`, the
 * same permission as the move it is for (`POST /api/uploads/assets/move`).
 * Only the sentence and the Journey's labels reach the provider; the answer
 * names Route Points of that Journey only, or no proposal.
 */
intentRoutes.post("/assign-media", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  const body = await readJsonObject(() => context.req.json());
  const input = parseAssignMediaRequest(body);
  if (!input) {
    return context.json(
      {
        error: "INVALID_ASSIGN_MEDIA_INTENT",
        message: "Write one sentence of up to 200 characters about 1 to 256 selected media",
      },
      400,
    );
  }
  if (serverConfig.intentDriver !== "http-model") throw new AssignMediaIntentUnavailableError();
  const proposal = await assignMediaProposal(atlas.id, input);
  if (!proposal) return context.json(JOURNEY_NOT_FOUND, 404);
  return context.json({ proposal, model: serverConfig.intentModel! });
});

/**
 * The longest sentence each routed intent's own reader accepts. The router
 * refuses a sentence longer than every offered intent allows before any
 * provider call, and re-checks the chosen intent's own bound after stage 1.
 */
export const ROUTED_INTENT_TEXT_LIMITS: Record<RoutedIntent, number> = {
  "create-journey": MAX_JOURNEY_SENTENCE_LENGTH,
  share: MAX_SHARE_INTENT_TEXT_LENGTH,
  "share-photos-filter": MAX_SHARE_INTENT_TEXT_LENGTH,
  "route-order": MAX_ROUTE_ORDER_TEXT_LENGTH,
  "assign-photos": MAX_ASSIGN_MEDIA_TEXT_LENGTH,
  navigate: MAX_SHARE_INTENT_TEXT_LENGTH,
  "globe-focus": MAX_SHARE_INTENT_TEXT_LENGTH,
};

/**
 * The permission of the route each intent's proposal is applied through,
 * checked again before stage 2: a member who could not apply the proposal
 * cannot spend the provider on reading it.
 */
export const ROUTED_INTENT_PERMISSIONS: Record<RoutedIntent, AtlasAction> = {
  // The Composer creates the Journey (`POST /api/journeys`).
  "create-journey": "create",
  share: "create",
  "share-photos-filter": "create",
  // Saving the reordered draft is `PATCH /api/journeys/:id`.
  "route-order": "update",
  // The selected photos move through `POST /api/uploads/assets/move`.
  "assign-photos": "update",
  navigate: "read",
  "globe-focus": "read",
};

function routerConfig() {
  return {
    intentDriver: serverConfig.intentDriver,
    intentVisionModel: serverConfig.intentVisionModel,
    itineraryRecognitionDriver: serverConfig.itineraryRecognitionDriver,
  };
}

function intentModelOptions() {
  return {
    baseUrl: serverConfig.intentBaseUrl!,
    apiKey: serverConfig.intentApiKey!,
    model: serverConfig.intentModel!,
    timeoutMs: serverConfig.intentTimeoutMs,
    fetcher: shareIntentDependencies.fetcher,
  };
}

function textTooLong(limit: number) {
  return {
    error: "INTENT_TEXT_TOO_LONG",
    message: `Write one sentence of up to ${limit} characters`,
    limit,
  };
}

/** One routed sentence at a time per Atlas, in this process. */
const routerInFlight = new Set<string>();

/**
 * The command bar: one sentence, two stages. Stage 1 (`read`) sends only the
 * sentence and the offered intents; stage 2 re-checks the chosen intent's own
 * permission and calls its existing reader. The answer is a proposal only.
 */
intentRoutes.post("/route", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  const body = await readJsonObject(() => context.req.json());
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const commandContext = body?.context && typeof body.context === "object" && !Array.isArray(body.context)
    ? body.context as Record<string, unknown>
    : null;
  const available = availableRouterIntents(routerConfig());
  if (available.length === 0) throw new RouterIntentUnavailableError();
  // Photo assignment exists only over a Story selection the move route could
  // carry; without one it is never offered to stage 1, whatever the client says.
  const selection = parseAssignMediaSelection(
    commandContext?.activeJourneyId,
    commandContext?.selectionCount,
  );
  const offered = narrowOfferedIntents(commandContext?.intents, available)
    ?.filter((intent) => intent !== "assign-photos" || selection !== null) ?? null;
  if (!offered || offered.length === 0) {
    return context.json(
      { error: "INVALID_INTENT_ROUTE", message: "Offer at least one available intent" },
      400,
    );
  }
  const limit = Math.max(...offered.map((intent) => ROUTED_INTENT_TEXT_LIMITS[intent]));
  if (text.length < 1) {
    return context.json({ error: "INVALID_INTENT_ROUTE", message: "Write one sentence" }, 400);
  }
  if (text.length > limit) return context.json(textTooLong(limit), 400);
  if (routerInFlight.has(atlas.id)) {
    throw new RouterIntentError("INTENT_ROUTE_BUSY", "A sentence of this Atlas is already being read", 409);
  }

  routerInFlight.add(atlas.id);
  try {
    const model = serverConfig.intentModel!;
    const classification = await classifyCommand(intentModelOptions(), { text, offered });
    const intent = classification.intent;
    if (intent === UNSUPPORTED_INTENT) {
      return context.json({ intent, proposal: null, unmatched: classification.unmatched, model });
    }
    // The chosen intent's own permission, before its reader runs.
    await requireAtlasAccess(context.req.raw, ROUTED_INTENT_PERMISSIONS[intent]);
    if (text.length > ROUTED_INTENT_TEXT_LIMITS[intent]) {
      return context.json({ intent, ...textTooLong(ROUTED_INTENT_TEXT_LIMITS[intent]) }, 400);
    }
    const answer = (proposal: unknown) => context.json({
      intent,
      proposal,
      unmatched: classification.unmatched,
      model,
    });

    switch (intent) {
      case "create-journey":
        // The Composer reads it through its existing sentence import.
        return answer({ sentence: text });
      case "globe-focus":
        return answer({});
      case "route-order": {
        const input = parseRouteOrderRequest({ text, points: commandContext?.composerPoints });
        if (!input) {
          return context.json(
            {
              intent,
              error: "INVALID_ROUTE_ORDER_INTENT",
              message: "Write one sentence of up to 200 characters about 2 to 64 Route Points",
            },
            400,
          );
        }
        const reader = createRouteOrderIntentReader({
          driver: serverConfig.intentDriver,
          baseUrl: serverConfig.intentBaseUrl,
          apiKey: serverConfig.intentApiKey,
          model: serverConfig.intentModel,
          timeoutMs: serverConfig.intentTimeoutMs,
          fetcher: shareIntentDependencies.fetcher,
        });
        return answer((await reader.read(input)).proposal);
      }
      case "assign-photos": {
        // Offered only with a valid selection (narrowed above).
        const proposal = await assignMediaProposal(atlas.id, { text, journeyId: selection!.journeyId });
        if (!proposal) return context.json({ intent, ...JOURNEY_NOT_FOUND }, 404);
        return answer(proposal);
      }
      case "navigate": {
        const candidates = await listJourneyShareCandidatesForAtlas(atlas.id, MAX_SHARE_INTENT_CANDIDATES);
        const now = shareIntentDependencies.now?.() ?? new Date();
        return answer(await readNavigateIntent(intentModelOptions(), {
          text,
          today: now.toISOString().slice(0, 10),
          candidates,
        }));
      }
      case "share":
      case "share-photos-filter": {
        const reader = createShareIntentReader({
          driver: serverConfig.intentDriver,
          baseUrl: serverConfig.intentBaseUrl,
          apiKey: serverConfig.intentApiKey,
          model: serverConfig.intentModel,
          timeoutMs: serverConfig.intentTimeoutMs,
          fetcher: shareIntentDependencies.fetcher,
        });
        const candidates = await listJourneyShareCandidatesForAtlas(atlas.id, MAX_SHARE_INTENT_CANDIDATES);
        const now = shareIntentDependencies.now?.() ?? new Date();
        const reading = await reader.read({ text, today: now.toISOString().slice(0, 10), candidates });
        const proposal = boundShareIntentProposal(reading.proposal, candidates, MAX_SHARE_JOURNEYS);
        // The router chose the filter; the card then runs `/share/media`.
        return answer(intent === "share-photos-filter"
          ? { ...proposal, mediaFilter: "no-people" }
          : proposal);
      }
    }
  } finally {
    routerInFlight.delete(atlas.id);
  }
});
