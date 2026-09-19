/**
 * #379 (slice 4 of #367): whether this Journey may open with its cover reveal,
 * and with which images.
 *
 * Pure on purpose, exactly like `journeyModel.ts` and `coverRevealFlow.ts`: the
 * product rules the owner approved on #379 are decidable from data alone, so
 * they are asserted in the default node environment and the component keeps
 * only the fetch and the DOM.
 *
 * The rules, from the owner decision of 2026-09-15 on #379:
 *
 * - the opening is the existing Journey cover surface, not every media change;
 * - it plays at most ONCE per cover revision, so replacing the cover is what
 *   creates a new opportunity and browsing photographs is not;
 * - the preset is whatever the server pinned to the derivative; there is no
 *   user-facing effects picker;
 * - Reduced Motion goes straight to the canonical original cover;
 * - anything missing, stale, unreadable or unrecognised is not an error the
 *   viewer has to see. It is simply no opening, and the canonical original
 *   cover was never withheld waiting for it.
 */

import type { CoverRevealImagePair, RevealPresetId } from "../reveal/coverRevealFlow";
import type { JourneyMediaAsset } from "./types";

/** The five presets the vendored renderer actually implements. */
export const REVEAL_PRESET_IDS: readonly RevealPresetId[] = [
  "ink-bloom",
  "guided-ribbon",
  "brush-sweep",
  "fiber-soak",
  "mist-veil",
];

/**
 * What `GET /api/cover-reveal/journeys/:id` (#386) answered.
 *
 * Deliberately typed as the wire shape rather than an already-validated one:
 * every field below is checked here, because a derivative row is produced by
 * an external worker and `presetId` is a plain server string column.
 */
export type CoverRevealDisplayPayload = {
  derivative: {
    id: string;
    journeyId: string;
    presetId: string;
    sourceMediaAssetId: string;
    sourceContentHash: string;
    mimeType: string;
    width: number;
    height: number;
  } | null;
  display?: { url: string; expiresAt: string } | null;
  reason?: string | null;
};

/**
 * The identity of one opening opportunity.
 *
 * Both halves of the server's pin, because the asset id alone does not name a
 * revision: replacing the photograph behind the same cover asset keeps the id
 * and moves the verified stored-byte identity. This is the key the
 * once-per-cover-revision ledger is kept under.
 */
export function coverRevealOpeningIdentity(
  journeyId: string,
  sourceMediaAssetId: string,
  sourceContentHash: string,
): string {
  return `${journeyId} ${sourceMediaAssetId} ${sourceContentHash}`;
}

/** Why no opening plays. None of these is ever shown to the viewer. */
export type CoverRevealOpeningSkip =
  | "no-cover"
  | "no-derivative"
  | "stale-cover"
  | "unusable-derivative"
  | "already-played"
  | "reduced-motion"
  | "newer-intent";

export type CoverRevealOpeningDecision =
  | { kind: "open"; identity: string; preset: RevealPresetId; generatedUrl: string }
  | { kind: "none"; reason: CoverRevealOpeningSkip };

export type CoverRevealOpeningInput = {
  journeyId: string;
  /** The cover as the client resolves it right now, i.e. `journeyCover()`. */
  cover: JourneyMediaAsset | null;
  payload: CoverRevealDisplayPayload | null;
  /** Identities whose one opportunity has already been spent this session. */
  played: ReadonlySet<string>;
  reducedMotion: boolean;
  /**
   * True when Story, Playback, another Journey or any other surface already
   * owns the viewer's attention. A newer intent never hands it back.
   */
  supersededByIntent: boolean;
};

/**
 * Decide whether this Journey opens with a reveal.
 *
 * The cover comparison is re-run here rather than trusted from the moment the
 * payload was fetched, so this is also the apply-time check that a late
 * completion cannot attach to a cover the viewer has since replaced.
 */
export function planCoverRevealOpening(
  input: CoverRevealOpeningInput,
): CoverRevealOpeningDecision {
  const { cover, payload } = input;
  if (input.supersededByIntent) return { kind: "none", reason: "newer-intent" };
  if (!cover) return { kind: "none", reason: "no-cover" };
  if (!payload || !payload.derivative) return { kind: "none", reason: "no-derivative" };

  const derivative = payload.derivative;
  // Not `stale-cover` when the Journey itself differs: a payload belonging to
  // another Journey is an unusable answer, not a cover that moved.
  if (derivative.journeyId !== input.journeyId) {
    return { kind: "none", reason: "unusable-derivative" };
  }
  if (
    derivative.sourceMediaAssetId !== cover.id
    // A cover with no verified content hash cannot be matched against the pin
    // the server recorded, so it gets no opening rather than a guessed one.
    // The server refuses to generate from such a source at all, so this is
    // only ever reached with a payload that has stopped describing this cover.
    || !cover.contentHash
    || cover.contentHashVerified !== true
    || derivative.sourceContentHash !== cover.contentHash
  ) {
    return { kind: "none", reason: "stale-cover" };
  }

  const display = payload.display;
  if (!display || typeof display.url !== "string" || display.url.length === 0) {
    return { kind: "none", reason: "unusable-derivative" };
  }
  if (
    !Number.isFinite(derivative.width) || derivative.width <= 0
    || !Number.isFinite(derivative.height) || derivative.height <= 0
  ) {
    return { kind: "none", reason: "unusable-derivative" };
  }
  // The preset is the server's choice, and an unrecognised one names a
  // derivative this build cannot render. Substituting the renderer default
  // would be inventing a visual direction the server never pinned.
  if (!REVEAL_PRESET_IDS.includes(derivative.presetId as RevealPresetId)) {
    return { kind: "none", reason: "unusable-derivative" };
  }

  const identity = coverRevealOpeningIdentity(
    input.journeyId,
    derivative.sourceMediaAssetId,
    derivative.sourceContentHash,
  );
  // Spent revisions are checked before Reduced Motion so the two answers stay
  // independent: a revision already spent stays spent whichever way it went.
  if (input.played.has(identity)) return { kind: "none", reason: "already-played" };
  if (input.reducedMotion) return { kind: "none", reason: "reduced-motion" };

  return {
    kind: "open",
    identity,
    preset: derivative.presetId as RevealPresetId,
    generatedUrl: display.url,
  };
}

/** The two images one opening runs with, held for exactly that opening. */
export type HeldCoverRevealPair = {
  identity: string;
  pair: CoverRevealImagePair;
};

/**
 * The image pair for the opening currently on screen, frozen for its lifetime.
 *
 * The canonical original cover re-signs itself on its own timer, and that timer
 * is floored at one second — a share grant with seconds left (#200) reaches the
 * floor — so the original's url can change several times inside one reveal.
 * `CoverRevealStage` rebuilds its renderer whenever the pair it was given
 * changes, so recomputing the pair from the current url would restart the
 * reveal from the first frame against a half it never opened with. A held url
 * only has to outlive the one reveal it opened: `CoverRevealStage` reads it to
 * load its textures and to render the original-cover image it settles and
 * degrades onto, and the pair is released as soon as that opening ends.
 *
 * A new opening identity always takes a fresh pair: that is a different cover
 * revision, not a re-signed read of the same one.
 *
 * The original url is required to BEGIN an opening and not to continue one.
 * Every refresh puts that read back through `loading`, so a pair recomputed
 * from the current url would unmount the stage for each gap and remount it
 * into a restart — which is exactly how a refresh inside a reveal was found to
 * break it. Once both images are loaded, a reveal needs neither url again.
 */
export function holdCoverRevealOpeningPair(
  held: HeldCoverRevealPair | null,
  opening: { identity: string; generatedUrl: string } | null,
  originalUrl: string | null,
): HeldCoverRevealPair | null {
  if (!opening) return null;
  if (held && held.identity === opening.identity) return held;
  if (!originalUrl) return null;
  return {
    identity: opening.identity,
    pair: { generatedFirst: opening.generatedUrl, originalCover: originalUrl },
  };
}

/**
 * The opening that is allowed on screen for THIS render.
 *
 * Clearing a superseded opening from state is housekeeping that happens after
 * the commit, so it cannot be what keeps last revision's derivative off the
 * screen: between the render that moved the cover pin and the effect that
 * clears the state, one frame would still paint the old opening against the new
 * cover. #379 forbids exactly that — old cover data must never attach to a new
 * revision — so the rejection is decided here, during render, and the effect
 * only releases the state afterwards.
 *
 * `enabled` is part of the same answer: Story, Playback or any other surface
 * taking the viewer ends the opening in the same commit that hands the surface
 * over, rather than one paint later.
 */
export function mountedCoverRevealOpening<T extends { identity: string }>(
  opening: T | null,
  coverPin: string | null,
  enabled: boolean,
): T | null {
  if (opening === null || !enabled || coverPin === null) return null;
  return opening.identity === coverPin ? opening : null;
}
