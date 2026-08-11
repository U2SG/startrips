import { useEffect, useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconPhoto,
  IconX,
} from "@tabler/icons-react";
import { getPrivateMediaRead } from "./journeyApi";
import type { Journey } from "./types";
import { useModalFocus } from "./useModalFocus";

type MediaReadState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

type JourneyStoryProps = {
  journeys: readonly Journey[];
  journeyId: string;
  onClose: () => void;
  onNavigate: (journeyId: string) => void;
};

function journeyRange(journey: Journey) {
  return journey.endedOn && journey.endedOn !== journey.startedOn
    ? `${journey.startedOn} — ${journey.endedOn}`
    : journey.startedOn;
}

export function JourneyStory({
  journeys,
  journeyId,
  onClose,
  onNavigate,
}: JourneyStoryProps) {
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeys[journeyIndex];
  const [assetIndex, setAssetIndex] = useState(0);
  const [mediaReads, setMediaReads] = useState<Record<string, MediaReadState>>({});
  const dialogRef = useModalFocus<HTMLElement>(onClose);

  useEffect(() => {
    setAssetIndex(0);
  }, [journeyId]);

  useEffect(() => {
    let cancelled = false;
    if (!journey || journey.media.length === 0) {
      setMediaReads({});
      return () => {
        cancelled = true;
      };
    }

    setMediaReads(Object.fromEntries(
      journey.media.map((asset) => [asset.id, { status: "loading" }]),
    ));
    for (const asset of journey.media) {
      void getPrivateMediaRead(asset.id).then(
        (read) => {
          if (cancelled) return;
          setMediaReads((current) => ({
            ...current,
            [asset.id]: { status: "ready", url: read.url },
          }));
        },
        (error) => {
          if (cancelled) return;
          setMediaReads((current) => ({
            ...current,
            [asset.id]: {
              status: "error",
              message: error instanceof Error ? error.message : "媒体读取失败",
            },
          }));
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [journey]);

  const namedStops = useMemo(
    () => journey?.routePoints.filter((point) => point.isStop) ?? [],
    [journey],
  );

  if (!journey) return null;
  const asset = journey.media[assetIndex] ?? null;
  const read = asset ? mediaReads[asset.id] : null;
  const previousJourney = journeyIndex > 0 ? journeys[journeyIndex - 1] : null;
  const nextJourney = journeyIndex < journeys.length - 1 ? journeys[journeyIndex + 1] : null;

  return (
    <div className="journey-story-backdrop" role="presentation">
      <article ref={dialogRef} tabIndex={-1} className="journey-story" role="dialog" aria-modal="true" aria-labelledby="journey-story-title">
        <header>
          <div>
            <p>PRIVATE JOURNEY · {journeyRange(journey)}</p>
            <h2 id="journey-story-title">{journey.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭故事"><IconX size={20} stroke={1.35} aria-hidden="true" /></button>
        </header>

        <div className="journey-story__layout">
          <section className="journey-story__media" aria-label="旅程媒体">
            {!asset ? <div className="journey-story__empty-media"><IconPhoto size={36} stroke={1.05} style={{ color: journey.lightColor }} aria-hidden="true" />这段旅程没有附加媒体</div> : null}
            {asset && (!read || read.status === "loading") ? <div className="journey-story__media-state">正在打开私有媒体…</div> : null}
            {asset && read?.status === "error" ? <div className="journey-story__media-state is-error">{read.message}</div> : null}
            {asset && read?.status === "ready" && asset.mimeType.startsWith("video/") ? <video key={asset.id} src={read.url} controls playsInline preload="metadata" /> : null}
            {asset && read?.status === "ready" && !asset.mimeType.startsWith("video/") ? <img key={asset.id} src={read.url} alt={asset.fileName} /> : null}
            {journey.media.length > 1 ? (
              <nav className="journey-story__media-nav" aria-label="媒体导航">
                <button type="button" disabled={assetIndex === 0} onClick={() => setAssetIndex((current) => current - 1)} aria-label="上一个媒体"><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" /></button>
                <span>{assetIndex + 1} / {journey.media.length}</span>
                <button type="button" disabled={assetIndex === journey.media.length - 1} onClick={() => setAssetIndex((current) => current + 1)} aria-label="下一个媒体"><IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
              </nav>
            ) : null}
          </section>

          <section className="journey-story__copy">
            <dl>
              <div><dt>ROUTE POINTS</dt><dd>{journey.routePoints.length}</dd></div>
              <div><dt>STOPS</dt><dd>{namedStops.length}</dd></div>
            </dl>
            {namedStops.length > 0 ? <p className="journey-story__stops">{namedStops.map((stop) => stop.label).join(" · ")}</p> : null}
            {journey.note ? <p className="journey-story__note">{journey.note}</p> : <p className="journey-story__note is-empty">没有文字，只有这条路线留下来。</p>}
          </section>
        </div>

        <footer>
          <button type="button" disabled={!previousJourney} onClick={() => previousJourney && onNavigate(previousJourney.id)}><IconArrowLeft size={17} stroke={1.35} aria-hidden="true" />上一段</button>
          <button type="button" disabled={!nextJourney} onClick={() => nextJourney && onNavigate(nextJourney.id)}>下一段<IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
        </footer>
      </article>
    </div>
  );
}
