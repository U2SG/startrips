import { useCallback, useEffect, useRef, useState } from "react";
import type { RevealPresetId } from "../reveal/coverRevealFlow";
import { readCoverRevealDisplay } from "./journeyApi";
import { journeyCover } from "./journeyModel";
import {
  coverRevealOpeningIdentity,
  mountedCoverRevealOpening,
  planCoverRevealOpening,
  type CoverRevealDisplayPayload,
} from "./coverRevealOpening";
import type { Journey } from "./types";

/**
 * #379: the Journey cover opening, as one thing the Atlas owns.
 *
 * The ledger of spent opportunities lives HERE rather than inside the cover
 * component, because the cover has two mount sites — the desktop active panel
 * and the mobile sheet — and a ledger inside either of them would let crossing
 * a breakpoint replay an opening the viewer has already seen.
 *
 * Everything this hook returns is additive. The canonical original cover is
 * read, shown and refreshed by `JourneyCardMedia` exactly as before; a missing,
 * pending, stale, failed or unreadable derivative simply produces no opening,
 * silently, with the original already on screen.
 */

export type CoverRevealOpening = {
  /** Stable across a re-signed display url; the ledger key for this revision. */
  identity: string;
  preset: RevealPresetId;
  /** The short-lived signed read of the derivative shown as the first frame. */
  generatedUrl: string;
};

export type CoverRevealOpeningControls = {
  /** Non-null only while an opening is actually on screen. */
  opening: CoverRevealOpening | null;
  /** Hand the surface back to the canonical original cover, at once. */
  dismiss: () => void;
};

type ReadDisplay = (journeyId: string) => Promise<CoverRevealDisplayPayload>;

export function useCoverRevealOpening({
  journey,
  enabled,
  reducedMotion,
  readDisplay = readCoverRevealDisplay,
}: {
  /** The Journey whose cover surface is on screen, or null when none is. */
  journey: Journey | null;
  /**
   * False as soon as any other surface owns the viewer: Story, Playback, the
   * composer, a dialog, or a view that is not the planet.
   */
  enabled: boolean;
  reducedMotion: boolean;
  readDisplay?: ReadDisplay;
}): CoverRevealOpeningControls {
  const [opening, setOpening] = useState<CoverRevealOpening | null>(null);
  // True from the moment the display read leaves until it resolves. The
  // pending window needs the same intent guard the mounted opening has: an
  // answer that arrives after the viewer has moved on must not start a reveal
  // behind them, and must not allocate a graphics context for it.
  const [awaitingRead, setAwaitingRead] = useState(false);
  // Session-scoped on purpose: "once per cover revision" is a rule about one
  // visit, and persisting it would invent a storage contract #379 never asked
  // for. A reload is a new visit and may open again.
  const played = useRef<Set<string>>(new Set());
  /**
   * Monotonic count of viewer intents, so a read in flight can tell whether
   * the viewer it was started for is still the current one. A ref rather than
   * state: an intent during the pending window must be observable by the
   * already-running request without re-rendering anything.
   */
  const intent = useRef(0);

  const dismiss = useCallback(() => {
    intent.current += 1;
    setOpening((current) => (current === null ? current : null));
  }, []);

  const cover = journey ? journeyCover(journey) : null;
  const journeyId = journey?.id ?? null;
  // The exact revision this effect is about. Recomputing the effect from the
  // pin rather than from the Journey object means an unrelated Journey edit —
  // a note, a route point, another photograph — does not re-ask for anything.
  const coverPin = cover && cover.contentHash && cover.contentHashVerified
    ? coverRevealOpeningIdentity(journeyId ?? "", cover.id, cover.contentHash)
    : null;

  useEffect(() => {
    if (!enabled || journeyId === null || coverPin === null) {
      dismiss();
      return undefined;
    }
    // An opening belongs to the exact cover revision it was granted for. When
    // the pin moves while one is mounted — the cover replaced, or the surface
    // now showing another Journey — the old derivative has to leave the screen
    // HERE, synchronously, before anything is asked for the new revision.
    // `JourneyCardMedia` recombines whatever opening it is handed with the
    // original cover it currently holds, so a survivor would reveal last
    // revision's generated pixels into this revision's canonical cover.
    // Clearing rather than `dismiss()`: no intent is being expressed, and the
    // read this effect is about to start must not supersede itself.
    setOpening((current) => (current !== null && current.identity !== coverPin ? null : current));
    // Reduced Motion resolves to the canonical original with no reveal, so
    // there is nothing to ask for. Not minting a display capability nobody
    // will look at is the whole reason the check is here and not only in
    // `planCoverRevealOpening`, which still owns the decision.
    if (reducedMotion) return undefined;
    if (played.current.has(coverPin)) return undefined;

    let cancelled = false;
    const startedFor = intent.current;
    setAwaitingRead(true);
    void (async () => {
      let payload: CoverRevealDisplayPayload | null = null;
      try {
        payload = await readDisplay(journeyId);
      } catch {
        // A failed, unauthorised or offline read is not something the viewer
        // is told about: the cover they came for is already there.
        return;
      } finally {
        if (!cancelled) setAwaitingRead(false);
      }
      if (cancelled) return;
      const decision = planCoverRevealOpening({
        journeyId,
        cover,
        payload,
        played: played.current,
        reducedMotion,
        // Re-read at apply time rather than trusted from the moment the
        // request left: a Journey the viewer has since left, a cover they have
        // since replaced, or any input they gave while this was in flight must
        // not be claimed by an answer arriving behind them. The opportunity is
        // NOT spent in that case — nothing ever appeared for them to interrupt.
        supersededByIntent: !enabled || intent.current !== startedFor,
      });
      if (decision.kind !== "open") return;
      // The opportunity is spent the moment it is taken, not when it finishes.
      // An opening the viewer interrupted still happened, and #379 gives each
      // cover revision exactly one.
      played.current.add(decision.identity);
      setOpening({
        identity: decision.identity,
        preset: decision.preset,
        generatedUrl: decision.generatedUrl,
      });
    })();

    return () => {
      cancelled = true;
      setAwaitingRead(false);
    };
    // `cover` and `readDisplay` are intentionally absent from the dependency
    // list: the pin already identifies the cover exactly, and a
    // caller-supplied reader is fixed for the life of the mount.
  }, [coverPin, dismiss, enabled, journeyId, reducedMotion]);

  // What may actually be on screen NOW. The effect above releases a superseded
  // opening from state, but it runs after the commit, so on its own it would
  // still let one frame paint last revision's derivative against this
  // revision's cover. The pin and the enabled surface are both known during
  // render, so the rejection is decided here and the effect is left as the
  // housekeeping that follows it.
  const mounted = mountedCoverRevealOpening(opening, coverPin, enabled);

  // Any newer intent takes the surface immediately — a click anywhere, a
  // swipe, a key, a wheel. Capture phase, so the opening yields before the
  // control under the pointer runs.
  //
  // Installed while the read is still PENDING as well as while an opening is
  // mounted. Watching only the mounted opening would leave the whole in-flight
  // window unguarded: a viewer who starts dragging the globe, or enters
  // globe-focus mode where this cover is merely opacity-hidden, would have a
  // reveal start behind them when the answer landed.
  useEffect(() => {
    if (mounted === null && !awaitingRead) return undefined;
    // Passive as well as capturing: yielding the surface never cancels the
    // gesture it is yielding to, and a blocking touch/wheel listener on the
    // document would make every scroll wait on this.
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const type of events) {
      document.addEventListener(type, dismiss, { capture: true, passive: true });
    }
    return () => {
      for (const type of events) {
        document.removeEventListener(type, dismiss, { capture: true });
      }
    };
  }, [awaitingRead, dismiss, mounted]);

  return { opening: mounted, dismiss };
}
