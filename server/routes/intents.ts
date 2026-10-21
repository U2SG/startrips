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
 */

import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import {
  boundShareIntentProposal,
  createShareIntentReader,
  ShareIntentUnavailableError,
} from "../intents/create-share-intent";
import { listJourneyShareCandidatesForAtlas } from "../repositories/journey-repository";
import { readJsonObject } from "./json-body";
import { MAX_SHARE_JOURNEYS } from "./shares";

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

/** Overridable only so a test can hand in a fetcher and a clock. */
export const shareIntentDependencies: {
  fetcher?: typeof fetch;
  now?: () => Date;
} = {};

export const intentRoutes = new Hono();

intentRoutes.get("/capabilities", async (context) => {
  await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", SHARE_INTENT_CACHE_CONTROL);
  return context.json({
    share: { configured: serverConfig.intentDriver !== "disabled" },
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
