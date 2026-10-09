import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlaybackMediaStage } from "../journey/PlaybackMediaStage";
import { StoryMediaPages } from "../journey/StoryMediaPages";
import { compactMobileLayoutMarker, useCompactMobileLayout } from "../journey/mobileLayout";
import type { JourneyMediaAsset } from "../journey/types";
import { prefersReducedMotion } from "../motion/preferences";
import { cancelSharedElementMorph, runSharedElementMorph } from "../motion/primitives/sharedElement";
import "../styles/media-motion-lab.css";

type Mode = "explore" | "playback";
type Density = "empty" | "single" | "few" | "sequence" | "dense";
type Scenario = "direct" | "delayed" | "mixed" | "video-first" | "shared" | "stale" | "failure";
type Read = { status: "ready"; url: string } | { status: "loading" } | { status: "error"; message: string };
type Snapshot = {
  requested: string | null;
  presented: string | null;
  phase: string;
  covered: boolean;
  liveVideoCount: number;
  dragX: string;
};
type TraceContext = { scenario: Scenario; mode: Mode; density: Density; viewport: string; reducedMotion: boolean; topology: string };
type TraceEntry = TraceContext & { phase: string; at: number; assetId?: string };

declare global {
  interface Window {
    __mediaMotionLab?: { marks: TraceEntry[]; native: (TraceContext & { type: string; startTime: number; duration: number })[] };
  }
}

const COUNTS: Record<Density, number> = { empty: 0, single: 1, few: 3, sequence: 6, dense: 12 };
const IMAGES = [
  "/artworks/hokusai-wave.jpg",
  "/artworks/greek-amphora.jpg",
  "/artworks/monet-water-lilies.jpg",
  "/artworks/han-dancer.jpg",
  "/artworks/mughal-akbarnama.jpg",
  "/artworks/sony-walkman-tps-l2.jpg",
];
const VIDEOS = ["/demo-media/east-star-orbit.webm", "/demo-media/qa-vertical-drift.webm"];
const MODES: Mode[] = ["explore", "playback"];
const DENSITIES: Density[] = ["empty", "single", "few", "sequence", "dense"];
const SCENARIOS: Scenario[] = ["direct", "delayed", "mixed", "video-first", "shared", "stale", "failure"];
const EMPTY_SNAPSHOT: Snapshot = { requested: null, presented: null, phase: "spatial", covered: true, liveVideoCount: 0, dragX: "0px" };

function selected<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

/** A public fixture asset; its bytes come from a public URL, not signed reads. */
type LabMediaAsset = JourneyMediaAsset & { fixtureUrl: string };

function fixtureMedia(density: Density, scenario: Scenario): LabMediaAsset[] {
  return Array.from({ length: COUNTS[density] }, (_, index) => {
    const video = scenario === "mixed" ? index % 3 === 1
      : scenario === "video-first" ? index === 0 : density === "dense" && index % 5 === 3;
    const url = video ? VIDEOS[index % VIDEOS.length] : IMAGES[index % IMAGES.length];
    return {
      id: `lab-${index + 1}`,
      journeyId: "public-media-motion-lab",
      routePointId: "public-lab-point",
      fixtureUrl: url,
      fileName: video ? `Public video ${index + 1}` : `Public image ${index + 1}`,
      mimeType: video ? "video/webm" : "image/jpeg",
      bytes: 0,
      sortOrder: index,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  });
}

function initialReads(media: LabMediaAsset[], scenario: Scenario): Record<string, Read> {
  return Object.fromEntries(media.map((asset, index) => [asset.id,
    index === 1 && (scenario === "delayed" || scenario === "stale" || scenario === "failure")
      ? { status: "loading" } : { status: "ready", url: asset.fixtureUrl },
  ]));
}

/** A swipe pulls the presented page off its depth-0 rest pose. */
function pagePullX(page: HTMLElement | null) {
  const transform = page ? getComputedStyle(page).transform : "none";
  return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0;
}

function stageSnapshot(stage: HTMLElement, mode: Mode): Snapshot {
  const presentation = stage.querySelector<HTMLElement>("[data-media-presentation]");
  const page = stage.querySelector<HTMLElement>('[data-media-presented="true"]');
  const requested = mode === "playback"
    ? presentation?.dataset.requestedAsset ?? null
    : stage.dataset.requestedAsset ?? null;
  const presented = mode === "playback"
    ? presentation?.dataset.presentedAsset ?? null
    : page?.dataset.mediaPageId ?? null;
  const owner = mode === "playback"
    ? stage.querySelector<HTMLElement>(`[data-media-asset="${presented ?? ""}"][aria-hidden="false"]`)
    : page;
  const painted = owner ? [...owner.querySelectorAll<HTMLElement>("img, video, canvas")].some((element) => {
    if (element.hidden || getComputedStyle(element).visibility === "hidden" || getComputedStyle(element).opacity === "0") return false;
    if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth > 0;
    if (element instanceof HTMLVideoElement) return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    return element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0;
  }) : false;
  const preview = owner?.dataset.mediaLayer === "preview";
  const visibleStoryVideo = stage.querySelector<HTMLVideoElement>('.story-media-pages__video[data-video-visible="true"] video');
  const storyVideoPainted = Boolean(visibleStoryVideo && !visibleStoryVideo.hidden
    && visibleStoryVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
  const liveVideoCount = [...stage.querySelectorAll<HTMLVideoElement>("video")]
    .filter((video) => !video.paused && !video.ended).length;
  return {
    requested,
    presented,
    phase: presentation?.dataset.mediaPresentation ?? "waiting",
    covered: Boolean(painted || preview || storyVideoPainted),
    liveVideoCount,
    dragX: `${Math.round(pagePullX(page))}px`,
  };
}

function LabSurface({ mode, density, scenario }: { mode: Mode; density: Density; scenario: Scenario }) {
  const media = useMemo(() => fixtureMedia(density, scenario), [density, scenario]);
  const [reads, setReads] = useState<Record<string, Read>>(() => initialReads(media, scenario));
  const [index, setIndex] = useState(0);
  const [incomingId, setIncomingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const [gestureHolding, setGestureHolding] = useState(false);
  const [gestureConsumed, setGestureConsumed] = useState(false);
  const [foregroundId, setForegroundId] = useState<string | null>(null);
  const [transportReady, setTransportReady] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [presentedId, setPresentedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const stageRef = useRef<HTMLDivElement>(null);
  const thumbnailRef = useRef<HTMLImageElement>(null);
  const current = media[index] ?? null;
  const incoming = media.find((asset) => asset.id === incomingId) ?? null;
  const held = media[1] ?? null;
  const compact = useCompactMobileLayout();
  const intent = `${mode}:${scenario}:${current?.id ?? "empty"}:${revision}`;
  const currentIntent = useRef(intent);
  currentIntent.current = intent;

  const mark = useCallback((phase: string, assetId?: string) => {
    const entry: TraceEntry = {
      phase, at: performance.now(), assetId, scenario, mode, density,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      reducedMotion: prefersReducedMotion(),
      topology: media.map((asset) => asset.mimeType.startsWith("video/") ? "video" : "image").join("→") || "empty",
    };
    const trace = window.__mediaMotionLab;
    if (trace) trace.marks.push(entry);
    performance.mark(`media-motion-lab:${phase}`);
  }, [density, media, mode, scenario]);

  useEffect(() => {
    window.__mediaMotionLab = { marks: [], native: [] };
    const kinds = ["interaction-contentful-paint", "soft-navigation"]
      .filter((kind) => PerformanceObserver.supportedEntryTypes.includes(kind));
    if (!kinds.length) return;
    const observer = new PerformanceObserver((list) => {
      const trace = window.__mediaMotionLab;
      if (!trace) return;
      trace.native.push(...list.getEntries().map((entry) => ({
        type: entry.entryType, startTime: entry.startTime, duration: entry.duration,
        scenario, mode, density, viewport: `${window.innerWidth}x${window.innerHeight}`,
        reducedMotion: prefersReducedMotion(),
        topology: media.map((asset) => asset.mimeType.startsWith("video/") ? "video" : "image").join("→") || "empty",
      })));
    });
    observer.observe({ entryTypes: kinds });
    return () => observer.disconnect();
  }, [density, media, mode, scenario]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !media.length) { setSnapshot(EMPTY_SNAPSHOT); return; }
    let lastPresented: string | null = null;
    const sample = () => {
      const next = stageSnapshot(stage, mode);
      setSnapshot((prior) => JSON.stringify(prior) === JSON.stringify(next) ? prior : next);
      if (next.presented && next.presented !== lastPresented && next.covered) {
        const presentedId = next.presented;
        lastPresented = presentedId;
        mark("presentable", presentedId);
        // The second frame bounds a paint opportunity after the presentable
        // commit. It is a fallback marker, not a browser paint entry.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const painted = stageSnapshot(stage, mode);
          if (stage.isConnected && painted.presented === presentedId && painted.covered) {
            mark("first-correct-frame", presentedId);
          }
        }));
      }
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(stage, { attributes: true, childList: true, subtree: true });
    for (const event of ["play", "pause", "ended", "loadeddata"]) stage.addEventListener(event, sample, true);
    return () => {
      observer.disconnect();
      for (const event of ["play", "pause", "ended", "loadeddata"]) stage.removeEventListener(event, sample, true);
    };
  }, [mark, media.length, mode]);

  useEffect(() => () => cancelSharedElementMorph(), []);

  const commit = useCallback((id: string) => {
    const next = media.findIndex((asset) => asset.id === id);
    if (next < 0) return;
    setIndex(next);
    setIncomingId(null);
    setPendingId(null);
    setPresentedId(id);
    mark("settled");
  }, [mark, media]);

  const request = (next: number) => {
    if (next < 0 || next >= media.length) return;
    const id = media[next].id;
    mark("input");
    mark("intent");
    mark("target-requested");
    setRevision((value) => value + 1);
    setPendingId(id);
    if (mode === "explore") setIncomingId(id);
    else setIndex(next);
  };

  const release = () => {
    if (!held) return;
    setReads((prior) => ({ ...prior, [held.id]: { status: "ready", url: held.fixtureUrl } }));
    mark("target-ready");
  };

  const fail = () => {
    if (!held) return;
    setReads((prior) => ({ ...prior, [held.id]: { status: "error", message: "Synthetic read failure" } }));
    setError("Synthetic read failure");
    mark("target-error");
  };

  const returnToA = () => {
    mark("intent");
    setRevision((value) => value + 1);
    setIncomingId(null);
    setPendingId(null);
    setIndex(0);
  };

  const sharedTarget = () => [...(stageRef.current?.querySelectorAll<HTMLElement>("[data-shared-media-id]") ?? [])]
    .find((element) => element.dataset.sharedMediaId === current?.id) ?? null;
  const morph = () => {
    if (!current || current.mimeType.startsWith("video/")) return;
    const next = !immersive;
    mark(next ? "immersive-entry" : "immersive-return");
    runSharedElementMorph({
      source: next ? thumbnailRef.current : sharedTarget(),
      resolveTarget: next ? sharedTarget : () => thumbnailRef.current,
      update: () => setImmersive(next),
      isTargetCurrent: () => currentIntent.current === intent,
      name: "media-motion-lab",
    });
  };

  const videoAsset = incoming?.mimeType.startsWith("video/") ? incoming
    : current?.mimeType.startsWith("video/") ? current : null;
  const videoRead = videoAsset && reads[videoAsset.id];
  const video = videoAsset && videoRead?.status === "ready"
    ? <video src={videoRead.url} muted playsInline preload="auto" /> : null;
  const read = current && reads[current.id];
  const url = read?.status === "ready" ? read.url : null;
  const peeks = media.length >= 4 ? media.slice(index + 1, index + 3)
    .filter((asset) => !asset.mimeType.startsWith("video/"))
    .map((asset) => ({ asset, url: asset.fixtureUrl })) : undefined;

  return <main className="media-motion-lab" data-media-motion-lab
    data-mode={mode} data-density={density} data-scenario={scenario}
    data-mobile-v2={compactMobileLayoutMarker(compact)}
    data-reduced-motion={prefersReducedMotion() ? "true" : "false"}
    data-requested-media={snapshot.requested ?? ""}
    data-presented-media={snapshot.presented ?? ""}
    data-stage-covered={snapshot.covered ? "true" : "false"}
    data-live-video-count={snapshot.liveVideoCount}
    data-gesture-phase={snapshot.phase}>
    <header className="media-motion-lab__header">
      <div><small>STARTRIPS · DEV / CI</small><h1>Media Motion Lab</h1>
        <p>Real Story and Playback media stages with public fixtures. No account or private Journey is loaded.</p></div>
      <a href="/">Exit lab</a>
    </header>
    <LabControls mode={mode} density={density} scenario={scenario} />
    <div className="media-motion-lab__workspace">
      <section className="media-motion-lab__viewer" aria-label="Media stage">
        <div className="media-motion-lab__source">
          {current && !current.mimeType.startsWith("video/") ? <img ref={thumbnailRef}
            src={current.fixtureUrl} alt="Shared element source" data-lab-shared-source /> : <span>Public Route Point</span>}
          <span>Route Point · 2026-01-01</span>
        </div>
        <div ref={stageRef} className={`media-motion-lab__stage${immersive ? " is-immersive" : ""}`}
          data-lab-stage data-requested-asset={incomingId ?? current?.id ?? ""}
          onPointerDownCapture={() => mark("input")}>
          {!current ? <div className="media-motion-lab__empty" data-lab-empty-chapter>
            <small>Spatial chapter</small><h2>Harbor crossing</h2>
            <p>There is no media at this Route Point. Its place and note complete the chapter.</p>
          </div> : mode === "explore" ? <StoryMediaPages
            scopeKey={`public-lab:${scenario}:${density}`}
            media={media} currentId={current.id} incomingId={incomingId} pendingId={pendingId}
            reads={reads} wrap={false} videoAssetId={videoAsset?.id ?? null} video={video}
            active onSettled={commit}
            onMediaError={(id, message) => { setError(`${id}: ${message}`); mark("media-error"); }}
            onPlaybackReady={setTransportReady}
            direction={incomingId && media.findIndex((asset) => asset.id === incomingId) < index ? -1 : 1}
            gestureEnabled={media.length > 1} mobileLayout={compact}
            onGestureClaim={commit} onGestureHoldingChange={setGestureHolding}
            onGestureConsumed={setGestureConsumed} onGestureCommit={commit}
            onGesturePrepare={(id) => { setPendingId(id); mark("target-requested"); }}
            onImageClick={scenario === "shared" ? morph : undefined}
            onNavigate={media.length > 1 ? (direction) => request(index + direction) : undefined}
            canNavigatePrevious={index > 0} canNavigateNext={index < media.length - 1}
            onForegroundChange={setForegroundId}
          /> : <PlaybackMediaStage
            asset={current} url={url} intent={intent} stepIndex={index}
            imageReady={Boolean(url)} videoPositionReady={Boolean(url)}
            failed={read?.status === "error"} buffering={false} paused={false}
            reduceMotion={prefersReducedMotion()} video={video}
            videoWaitTimeoutMs={8_000}
            onVideoElement={() => undefined} onPendingChange={setPending}
            onPresented={(id) => { setPresentedId(id); mark("settled"); }}
            onUnavailable={() => setError("Media unavailable")}
            isIntentCurrent={() => currentIntent.current === intent}
            sequencePeeks={peeks}
          />}
        </div>
        <nav className="media-motion-lab__actions" aria-label="Lab actions">
          {media.length > 1 ? <><button type="button" onClick={() => request(index - 1)} disabled={index === 0}>Previous</button>
            <button type="button" onClick={() => request(index + 1)} disabled={index === media.length - 1}>Next</button></> : null}
          {held && (scenario === "delayed" || scenario === "stale" || scenario === "failure") ? <>
            <button type="button" onClick={release}>Release target</button>
            <button type="button" onClick={fail}>Fail target</button>
          </> : null}
          {scenario === "stale" && media.length > 2 ? <>
            <button type="button" onClick={() => request(1)}>Request B</button>
            <button type="button" onClick={returnToA}>Return to A</button>
          </> : null}
          {scenario === "shared" && current && !current.mimeType.startsWith("video/") ?
            <button type="button" onClick={morph}>{immersive ? "Return from immersive" : "Enter immersive"}</button> : null}
        </nav>
      </section>
      <aside className="media-motion-lab__inspector" aria-label="Semantic owner state">
        <h2>Owner state</h2>
        <dl>
          <dt>Semantic asset</dt><dd data-lab-current>{current?.id ?? "spatial"}</dd>
          <dt>Requested</dt><dd data-lab-requested>{snapshot.requested ?? "none"}</dd>
          <dt>Presented</dt><dd data-lab-presented>{snapshot.presented ?? "none"}</dd>
          <dt>Physical stage</dt><dd data-lab-phase>{snapshot.phase}</dd>
          <dt>Covered</dt><dd data-lab-covered>{String(snapshot.covered)}</dd>
          <dt>Drag offset</dt><dd data-lab-drag>{snapshot.dragX}</dd>
          <dt>Gesture hold</dt><dd>{String(gestureHolding)}</dd>
          <dt>Gesture consumed</dt><dd>{String(gestureConsumed)}</dd>
          <dt>Foreground</dt><dd>{foregroundId ?? "none"}</dd>
          <dt>Transport ready</dt><dd>{transportReady ?? "none"}</dd>
          <dt>Playback pending</dt><dd>{String(pending)}</dd>
          <dt>Playback commit</dt><dd>{presentedId ?? "none"}</dd>
          <dt>Live videos</dt><dd data-lab-live-videos>{snapshot.liveVideoCount}</dd>
          <dt>Layout</dt><dd>{compact ? "compact mobile" : "desktop"}</dd>
          <dt>Motion</dt><dd>{prefersReducedMotion() ? "reduced" : "normal"}</dd>
          <dt>Error</dt><dd role={error ? "alert" : undefined}>{error || "none"}</dd>
        </dl>
      </aside>
    </div>
  </main>;
}

function LabControls({ mode, density, scenario }: { mode: Mode; density: Density; scenario: Scenario }) {
  const change = (name: "mode" | "density" | "scenario", value: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set(name, value);
    window.location.assign(`/?${params}`);
  };
  return <div className="media-motion-lab__controls" aria-label="Scenario controls">
    <label>Mode<select value={mode} onChange={(event) => change("mode", event.target.value)}>
      {MODES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>Density<select value={density} onChange={(event) => change("density", event.target.value)}>
      {DENSITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>Scenario<select value={scenario} onChange={(event) => change("scenario", event.target.value)}>
      {SCENARIOS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
  </div>;
}

export function MediaMotionLab() {
  const params = new URLSearchParams(window.location.search);
  const mode = selected(params.get("mode"), MODES, "explore");
  const density = selected(params.get("density"), DENSITIES, "sequence");
  const scenario = selected(params.get("scenario"), SCENARIOS, "direct");
  return <LabSurface key={`${mode}:${density}:${scenario}`} mode={mode} density={density} scenario={scenario} />;
}
