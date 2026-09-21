import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { springElementTo } from "../motion/springElement";
import { playbackMapBridgeBoundary, resolvePlaybackMapBridge, type PlaybackBridgeRect } from "./playbackMapBridge";
import type { JourneyPlaybackDirector } from "./useJourneyPlaybackDirector";
import type { Journey } from "./types";

/** Presentation adapter only. Playback still selects every beat and duration. */
export function usePlaybackMapBridge(input: {
  journey: Journey | null;
  director: JourneyPlaybackDirector;
  root: RefObject<HTMLDivElement | null>;
  reduceMotion: boolean;
  commitSpatial: () => void;
}) {
  const { journey, director, root, reduceMotion, commitSpatial } = input;
  const { stepIndex, steps, intentRevision, getIntentRevision, invalidatePresentation, paused } = director;
  const previous = useRef<{ journey: Journey | null; stepIndex: number; intent: number } | null>(null);
  const commitSpatialRef = useRef(commitSpatial);
  commitSpatialRef.current = commitSpatial;
  const mediaRect = useRef<{ stepIndex: number; rect: PlaybackBridgeRect | null } | null>(null);
  const boundary = useMemo(() => {
    const before = previous.current;
    if (!journey || !before || before.journey !== journey || before.intent !== intentRevision
      || before.stepIndex + 1 !== stepIndex) return null;
    return playbackMapBridgeBoundary(journey, steps[before.stepIndex], steps[stepIndex]);
  }, [intentRevision, journey, stepIndex, steps]);
  useLayoutEffect(() => {
    previous.current = { journey, stepIndex, intent: intentRevision };
  }, [intentRevision, journey, stepIndex]);
  useLayoutEffect(() => {
    // Invalidate synchronously, before any pending spring can commit ownership.
    const invalidate = () => invalidatePresentation();
    window.addEventListener("orientationchange", invalidate);
    window.screen.orientation?.addEventListener("change", invalidate);
    return () => {
      window.removeEventListener("orientationchange", invalidate);
      window.screen.orientation?.removeEventListener("change", invalidate);
    };
  }, [invalidatePresentation]);
  const isCurrent = useCallback(() => getIntentRevision() === intentRevision, [getIntentRevision, intentRevision]);
  const recordMedia = useCallback(() => {
    mediaRect.current = { stepIndex,
      rect: root.current?.querySelector('[data-presented-asset] [aria-hidden="false"]')?.getBoundingClientRect() ?? null,
    };
  }, [root, stepIndex]);
  const entrance = useCallback((element: HTMLElement) => {
    if (boundary?.direction !== "map-to-media" || !isCurrent()) return null;
    return resolvePlaybackMapBridge({ boundary,
      place: root.current?.querySelector(".journey-playback__stop")?.getBoundingClientRect() ?? null,
      media: element.getBoundingClientRect(), reduceMotion: reduceMotion || paused,
    });
  }, [boundary, isCurrent, paused, reduceMotion, root]);
  useLayoutEffect(() => {
    let cancelled = false;
    const commit = () => { if (!cancelled && isCurrent()) commitSpatialRef.current(); };
    if (boundary?.direction !== "media-to-map") { commit(); return; }
    const element = root.current?.querySelector<HTMLElement>(
      ".journey-playback__travel, .journey-playback__stop, .journey-playback__outro, .journey-playback__home",
    );
    const bridge = resolvePlaybackMapBridge({ boundary,
      place: element?.getBoundingClientRect() ?? null,
      media: mediaRect.current?.stepIndex === stepIndex - 1 ? mediaRect.current.rect : null,
      reduceMotion: reduceMotion || paused,
    });
    // The director already authorized this spatial beat. Commit its target in
    // the layout phase, before its timer can advance; the spring only presents
    // that destination. A fast nearby travel beat can end before the spring
    // settles, and cancelling that visual must not cancel the spatial intent.
    commit();
    if (!element || !bridge.spatial || !isCurrent()) return;
    element.style.transform = bridge.from.transform;
    element.style.opacity = String(bridge.from.opacity);
    const motion = springElementTo(element, bridge.to, { owner: `playback-map:${intentRevision}:${stepIndex}` });
    // No asynchronous focus commit survives seek/exit/step replacement.
    void motion.finished.catch(() => undefined);
    return () => {
      cancelled = true;
      motion.cancel();
      element.style.transform = "";
      element.style.opacity = "";
    };
  }, [boundary, intentRevision, isCurrent, journey, paused, reduceMotion, root, stepIndex]);
  return { entrance, isCurrent, recordMedia, boundary };
}
