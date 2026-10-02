import { useCallback, useEffect, useRef, useState } from "react";
import { captureVideoStill, type VideoStill } from "./videoStillFrame";
import type { JourneyMediaAsset, PrivateMediaRead } from "./types";

/**
 * #393: media plumbing shared by the trial Journey readers (Book, Stream).
 * Story keeps its own; these readers only ever read.
 */
export type ReaderRead =
  | { status: "loading" }
  | { status: "ready"; read: PrivateMediaRead }
  | { status: "error" };

export function isVideoAsset(asset: JourneyMediaAsset | null | undefined): boolean {
  return Boolean(asset?.mimeType.startsWith("video/"));
}

/**
 * Signed reads for the assets the reader is about to show. A read is not
 * renewed on a timer: swapping the URL under a loaded picture, a playing
 * video or the soundtrack would reload it. It is read again only when the
 * element reports it can no longer load it (`expireRead`), once.
 */
export function useReaderReads(
  readMedia: (assetId: string) => Promise<PrivateMediaRead>,
  wanted: readonly JourneyMediaAsset[],
) {
  const [reads, setReads] = useState<Record<string, ReaderRead>>({});
  const requestedRef = useRef(new Set<string>());
  const retriedRef = useRef(new Set<string>());
  const wantedKey = wanted.map((asset) => asset.id).join("|");

  useEffect(() => {
    for (const assetId of wantedKey ? wantedKey.split("|") : []) {
      if (reads[assetId] || requestedRef.current.has(assetId)) continue;
      requestedRef.current.add(assetId);
      setReads((previous) => ({ ...previous, [assetId]: { status: "loading" } }));
      void readMedia(assetId).then(
        (read) => setReads((previous) => ({ ...previous, [assetId]: { status: "ready", read } })),
        () => setReads((previous) => ({ ...previous, [assetId]: { status: "error" } })),
      ).finally(() => requestedRef.current.delete(assetId));
    }
  }, [wantedKey, reads, readMedia]);

  /** A media element loaded: a later expiry may be read again. */
  const clearRetry = useCallback((assetId: string) => {
    retriedRef.current.delete(assetId);
  }, []);

  /** A media element failed to load: read it once more, then report it. */
  const expireRead = useCallback((assetId: string) => {
    if (retriedRef.current.has(assetId)) {
      setReads((previous) => ({ ...previous, [assetId]: { status: "error" } }));
      return;
    }
    retriedRef.current.add(assetId);
    setReads((previous) => {
      const next = { ...previous };
      delete next[assetId];
      return next;
    });
  }, []);

  return { reads, expireRead, clearRetry };
}

/** A still for each nearby video that has no server poster (see videoStillFrame). */
export function useVideoStills(
  reads: Record<string, ReaderRead>,
  candidates: readonly JourneyMediaAsset[],
) {
  const [stills, setStills] = useState<Record<string, VideoStill | null>>({});
  const jobsRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    for (const asset of candidates) {
      if (!isVideoAsset(asset) || asset.id in stills || jobsRef.current.has(asset.id)) continue;
      const read = reads[asset.id];
      if (read?.status !== "ready" || read.read.preview) continue;
      const controller = new AbortController();
      jobsRef.current.set(asset.id, controller);
      void captureVideoStill(read.read.url, controller.signal).then((still) => {
        jobsRef.current.delete(asset.id);
        if (!controller.signal.aborted) setStills((previous) => ({ ...previous, [asset.id]: still }));
      });
    }
  }, [candidates, reads, stills]);

  useEffect(() => () => {
    for (const controller of jobsRef.current.values()) controller.abort();
  }, []);

  return stills;
}

/** The poster a video shows before it plays: the server's, else a decoded still. */
export function videoPosterUrl(read: ReaderRead | undefined, still: VideoStill | null | undefined): string | undefined {
  if (read?.status !== "ready") return undefined;
  return read.read.preview?.url ?? (still?.kind === "image" ? still.url : undefined);
}

/** Soundtrack level while a video is audible. */
const DUCKED_VOLUME = 0.18;
const DUCK_RAMP_MS = 420;

/**
 * The Journey soundtrack in a reader: on by default, off when the browser
 * refuses to start it, and lowered while a video is audible. Where a page may
 * not set the volume (iOS), it pauses for the video instead.
 */
export function useReaderSoundtrack(url: string | null, reduced: boolean) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [musicOn, setMusicOn] = useState(true);
  const [videoAudible, setVideoAudible] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !url) return;
    if (!musicOn) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setMusicOn(false));
  }, [musicOn, url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !url || !musicOn) return;
    const target = videoAudible ? DUCKED_VOLUME : 1;
    const probe = audio.volume;
    audio.volume = probe === 1 ? 0.99 : 1;
    const volumeIsFixed = audio.volume === probe;
    audio.volume = probe;
    if (volumeIsFixed) {
      if (videoAudible) audio.pause();
      else void audio.play().catch(() => undefined);
      return;
    }
    if (reduced) {
      audio.volume = target;
      return;
    }
    const from = audio.volume;
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - started) / DUCK_RAMP_MS);
      audio.volume = from + (target - from) * progress;
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [videoAudible, musicOn, url, reduced]);

  /** Started inside the tap: iOS refuses play() from an effect. */
  const toggleMusic = useCallback(() => {
    if (musicOn) {
      setMusicOn(false);
      return;
    }
    setMusicOn(true);
    void audioRef.current?.play().catch(() => setMusicOn(false));
  }, [musicOn]);

  /** Wire to the live video's play/pause/ended/emptied/volumechange. */
  const reportVideo = useCallback((video: HTMLVideoElement | null) => {
    setVideoAudible(Boolean(video && !video.paused && !video.ended && !video.muted && video.volume > 0));
  }, []);

  return { audioRef, musicOn, toggleMusic, reportVideo };
}
